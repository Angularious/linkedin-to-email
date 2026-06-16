import { NextRequest, NextResponse } from 'next/server'
import { checkBotId } from 'botid/server'
import { createServiceClient } from '@/lib/supabase'
import { hashIdentity } from '@/lib/hash'
import { verifyVisitorCookie } from '@/lib/identity'

const ORTHOGONAL_URL = 'https://api.orthogonal.com/v1/run'
const RATE_LIMIT = 3
const WINDOW_HOURS = 24

// Vercel Hobby kills a function at 10s. The slow path runs three provider phases
// sequentially — (Ocean ∥ Aviato ∥ Apollo) → Bytemine → ContactOut — so their
// timeouts must sum to well under 10s (plus bot check + DB overhead) or Vercel
// returns a platform 504 instead of our clean JSON. 3s + 2.5s + 3s + ~1s ≈ 9.5s.
const FAST_TIMEOUT_MS = 3000 // Tier 1: Ocean, Aviato, Apollo (cheap, parallel)
const MID_TIMEOUT_MS = 2500 // Tier 2: Bytemine (cheap-ish fallback)
const SLOW_TIMEOUT_MS = 3000 // Tier 3: ContactOut (expensive — last resort)

// Cap the function at the Hobby maximum explicitly.
export const maxDuration = 10

// Hard global ceiling on credits the demo can spend in a rolling 24h, in cents.
// A backstop independent of the per-user limit: even if that's bypassed, total
// spend can't exceed this. Default $25/day; override with DAILY_BUDGET_CENTS.
const DAILY_BUDGET_CENTS = Number(process.env.DAILY_BUDGET_CENTS ?? 2500)

// Per-provider cost in cents (Orthogonal charges on a successful HTTP call,
// regardless of whether an email was found). Ocean bills ~$0.0045 in practice;
// rounded up to 1¢ so the budget cap errs high.
const COST = { ocean: 1, apollo: 1, aviato: 1, bytemine: 3, contactout: 33 }

// Normalize any LinkedIn URL variant to https://www.linkedin.com/in/slug
function cleanLinkedInUrl(input: string): string | null {
  const match = input.trim().match(/linkedin\.com\/in\/([a-zA-Z0-9_-]+)/i)
  if (!match) return null
  return `https://www.linkedin.com/in/${match[1]}`
}

async function fetchWithTimeout(url: string, opts: RequestInit, ms: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Orthogonal REST API: GET endpoints use `query`, POST endpoints use `body`.
// Returns { ok } so callers can tell a clean "no result" from a real failure
// (timeout / network / non-2xx) — the two must surface differently to users.
async function callOrthogonal(
  api: string,
  path: string,
  params: Record<string, unknown>,
  httpMethod: 'GET' | 'POST' = 'POST',
  timeoutMs: number = FAST_TIMEOUT_MS
): Promise<{ ok: boolean; data: unknown }> {
  try {
    const res = await fetchWithTimeout(
      ORTHOGONAL_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.ORTHOGONAL_API_KEY}`,
        },
        body: JSON.stringify({
          api,
          path,
          [httpMethod === 'GET' ? 'query' : 'body']: params,
        }),
      },
      timeoutMs
    )
    if (!res.ok) {
      console.error(`[orthogonal] ${api}${path} → HTTP ${res.status}`)
      return { ok: false, data: null }
    }
    const json = await res.json()
    return { ok: true, data: (json as { data?: unknown })?.data ?? json }
  } catch (err) {
    console.error(`[orthogonal] ${api}${path} → ${(err as Error).name}`)
    return { ok: false, data: null }
  }
}

interface Profile {
  name?: string
  title?: string
  headline?: string
  location?: string
  company?: string
  companyLogo?: string
  companySize?: string
  companyIndustry?: string
  photoUrl?: string
}

// Merge partial profiles in priority order: the first provider with a value for
// a given field wins. Lets Apollo supply the photo while Ocean fills the company
// card and Bytemine backfills anything still missing.
function mergeProfiles(...parts: Array<Profile | undefined>): Profile | undefined {
  const merged: Profile = {}
  for (const p of parts) {
    if (!p) continue
    for (const k of Object.keys(p) as (keyof Profile)[]) {
      if (merged[k] === undefined && p[k] !== undefined) merged[k] = p[k]
    }
  }
  return Object.keys(merged).length ? merged : undefined
}

// Ocean.io takes the bare profile handle (slug), not the full URL. Batch
// endpoint: one handle in, people[0] out. Supplies a full profile incl. photo.
async function tryOcean(
  handle: string
): Promise<{ ok: boolean; email: string | null; profile?: Profile }> {
  const { ok, data } = await callOrthogonal('ocean-io', '/v2/lookup/people', {
    linkedinHandles: [handle],
    fields: ['name', 'jobTitle', 'headline', 'location', 'photo', 'email', 'email.address'],
  })
  const person = (data as { people?: Array<Record<string, unknown>> } | null)?.people?.[0]
  if (!person) return { ok, email: null }

  // `email` may come back as a string or as an { address } object.
  const emailField = person.email as { address?: string } | string | undefined
  const email = (typeof emailField === 'string' ? emailField : emailField?.address) || null

  const company = person.company as
    | { name?: string; logo?: string; companySize?: string; industries?: string[] }
    | undefined
  const profile: Profile = {
    name: (person.name as string) ?? undefined,
    title: (person.jobTitle as string) ?? undefined,
    headline: (person.headline as string) ?? undefined,
    location: (person.location as string) ?? undefined,
    company: company?.name ?? undefined,
    companyLogo: company?.logo ?? undefined,
    companySize: company?.companySize ?? undefined,
    companyIndustry: company?.industries?.[0] ?? undefined,
    photoUrl: (person.photo as string) ?? undefined,
  }
  return { ok, email, profile: profile.name || profile.title ? profile : undefined }
}

// Aviato returns a typed email list; work emails are preferred (work finder).
async function tryAviato(linkedinUrl: string): Promise<{ ok: boolean; emails: string[] }> {
  const { ok, data } = await callOrthogonal(
    'aviato',
    '/person/contact-info',
    { linkedinURL: linkedinUrl },
    'GET'
  )
  const list = (data as { emails?: Array<{ email?: string; type?: string }> } | null)?.emails
  if (!Array.isArray(list)) return { ok, emails: [] }
  const work = list.filter((e) => e.type === 'work').map((e) => e.email)
  const other = list.filter((e) => e.type !== 'work').map((e) => e.email)
  return { ok, emails: Array.from(new Set([...work, ...other].filter(Boolean) as string[])) }
}

async function tryApollo(
  linkedinUrl: string
): Promise<{ ok: boolean; email: string | null; verified: boolean; profile?: Profile }> {
  const { ok, data } = await callOrthogonal('apollo', '/api/v1/people/match', {
    linkedin_url: linkedinUrl,
    reveal_personal_emails: false,
  })
  const person = (data as { person?: Record<string, unknown> } | null)?.person
  if (!person) return { ok, email: null, verified: false }

  const org = person.organization as { name?: string; logo_url?: string } | undefined
  const location =
    [person.city as string, (person.state as string) || (person.country as string)]
      .filter(Boolean)
      .join(', ') || undefined
  const profile: Profile = {
    name: (person.name as string) ?? undefined,
    title: (person.title as string) ?? undefined,
    headline: (person.headline as string) ?? undefined,
    location,
    company: org?.name ?? undefined,
    companyLogo: org?.logo_url ?? undefined,
    photoUrl: (person.photo_url as string) ?? undefined,
  }

  return {
    ok,
    email: (person.email as string) || null,
    // Apollo tags each email: "verified" | "guessed" | "unavailable" | null.
    verified: (person.email_status as string) === 'verified',
    profile: profile.name || profile.title ? profile : undefined,
  }
}

async function tryContactOut(linkedinUrl: string): Promise<{ ok: boolean; emails: string[] }> {
  const { ok, data } = await callOrthogonal(
    'contactout',
    '/v1/people/linkedin',
    { profile: linkedinUrl },
    'GET',
    SLOW_TIMEOUT_MS
  )
  const p = (data as { profile?: { work_email?: string[]; email?: string[] } } | null)?.profile
  if (!p) return { ok, emails: [] }
  // Work emails first — this is a work-email finder.
  const workEmails = Array.isArray(p.work_email) ? p.work_email : []
  const anyEmails = Array.isArray(p.email) ? p.email : []
  return { ok, emails: Array.from(new Set([...workEmails, ...anyEmails])).filter(Boolean) }
}

// Bytemine: cheap-ish ($0.03) mid-tier. Returns a verified work email plus
// profile data (no photo), so it can also backfill the card if Ocean/Apollo miss.
async function tryBytemine(
  linkedinUrl: string
): Promise<{ ok: boolean; emails: string[]; verified: boolean; profile?: Profile }> {
  const { ok, data } = await callOrthogonal(
    'bytemine',
    '/contacts/enrich',
    { linkedin: linkedinUrl },
    'POST',
    MID_TIMEOUT_MS
  )
  const d = data as Record<string, unknown> | null
  if (!d) return { ok, emails: [], verified: false }

  const work = (d.work_email as string) || (d.email as string) || null
  const personal = (d.personal_email as string) || null
  const emails = Array.from(new Set([work, personal].filter(Boolean) as string[]))

  // Bytemine runs an SMTP check on the work email and reports the result.
  const ef = d.email_finder as { smtp_result?: string; confidence?: string } | undefined
  const verified = ef?.smtp_result === 'valid' || ef?.confidence === 'high'

  const location =
    [d.person_city as string, d.person_state as string].filter(Boolean).join(', ') || undefined
  const profile: Profile = {
    name: (d.full_name as string) ?? undefined,
    title: (d.job_title as string) ?? undefined,
    headline: (d.linkedin_headline as string) ?? undefined,
    location,
    company: (d.company_name as string) ?? undefined,
    companyIndustry: (d.company_industry as string) ?? undefined,
    companySize: (d.company_employee_range as string) ?? undefined,
  }
  return { ok, emails, verified, profile: profile.name || profile.title ? profile : undefined }
}

export async function POST(request: NextRequest) {
  // Never let an unexpected throw (e.g. Supabase misconfig) leak a bare HTML
  // 500 — a public API should always answer with clean JSON the UI can read.
  try {
    return await handleLookup(request)
  } catch (err) {
    console.error('[lookup] unhandled:', (err as Error).message)
    return NextResponse.json({ error: 'server' }, { status: 500 })
  }
}

async function handleLookup(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  const { url } = body as { url?: string }
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'

  // 0. Reject cross-origin POSTs. Our UI always sends a same-origin request
  //    (Origin host === Host); a present, mismatched Origin is a direct/CSRF-
  //    style call. A missing Origin is allowed (some privacy tools strip it) —
  //    BotID + the rate limit still cover those.
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
      }
    } catch {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  // 1. Validate input length, then clean + validate the LinkedIn URL (no cost,
  //    no DB — reject junk early before any bot check or paid work).
  if (typeof url !== 'string' || url.length > 2000) {
    return NextResponse.json({ invalid: true }, { status: 400 })
  }
  const cleanUrl = cleanLinkedInUrl(url)
  if (!cleanUrl) {
    return NextResponse.json({ invalid: true }, { status: 400 })
  }

  // 2. Bot check (Vercel BotID, 'basic' free tier). No-op in local dev. Runs
  //    before any DB or paid work so flagged bots cost us nothing.
  const bot = await checkBotId({ advancedOptions: { checkLevel: 'basic' } })
  if (bot.isBot) {
    return NextResponse.json({ error: 'bot_blocked' }, { status: 403 })
  }

  const supabase = createServiceClient()

  // 3. Global budget check BEFORE consuming the user's quota, so a user who
  //    hits the cap doesn't also burn one of their free lookups.
  const { data: spentCents, error: spendErr } = await supabase.rpc('recent_spend_cents', {
    p_window_hours: WINDOW_HOURS,
  })
  if (spendErr) {
    console.error('[lookup] spend check failed:', spendErr.message)
    return NextResponse.json({ error: 'server' }, { status: 500 }) // fail closed
  }
  if ((spentCents ?? 0) >= DAILY_BUDGET_CENTS) {
    return NextResponse.json({ at_capacity: true }, { status: 503 })
  }

  // 4. Atomic per-user rate limit (advisory-locked count + insert).
  //    Key on the signed visitor cookie when present (so distinct people on a
  //    shared IP each get their own quota), falling back to IP for cookieless
  //    clients (e.g. scripts hitting the API directly).
  const visitorId = await verifyVisitorCookie(request.cookies.get('lid')?.value)
  const identity = await hashIdentity(visitorId ? `v:${visitorId}` : `ip:${ip}`)
  const { data: attemptCount, error: rlErr } = await supabase.rpc('check_and_log_attempt', {
    p_identity: identity,
    p_limit: RATE_LIMIT,
    p_window_hours: WINDOW_HOURS,
  })
  if (rlErr) {
    console.error('[lookup] rate-limit check failed:', rlErr.message)
    return NextResponse.json({ error: 'server' }, { status: 500 }) // fail closed
  }
  if (attemptCount === -1) {
    return NextResponse.json({ rate_limited: true }, { status: 429 })
  }

  // 5. Tier 1 — three cheap providers in parallel ($0.01 each). First email
  //    wins; Apollo and Ocean also supply the profile card (Ocean takes the
  //    bare handle, the others the full URL).
  const handle = cleanUrl.split('/in/')[1]
  const [oceanR, aviatoR, apolloR] = await Promise.all([
    tryOcean(handle),
    tryAviato(cleanUrl),
    tryApollo(cleanUrl),
  ])

  let spent = 0
  const providers: string[] = []
  if (oceanR.ok) {
    spent += COST.ocean
    providers.push('ocean')
  }
  if (aviatoR.ok) {
    spent += COST.aviato
    providers.push('aviato')
  }
  if (apolloR.ok) {
    spent += COST.apollo
    providers.push('apollo')
  }

  // Field-level merge so each provider fills what it knows best (Apollo photo,
  // Ocean company card, etc.).
  let profile = mergeProfiles(apolloR.profile, oceanR.profile)
  // Aviato lists work emails first, so keep its order ahead of the singletons.
  let emails = Array.from(
    new Set([...aviatoR.emails, oceanR.email, apolloR.email].filter(Boolean) as string[])
  )
  // Track which specific emails a provider vouched for, so the "verified" badge
  // only attaches to an address we actually have a deliverability signal on.
  const verifiedEmails = new Set<string>()
  if (apolloR.verified && apolloR.email) verifiedEmails.add(apolloR.email)

  // 6. Tier 2 — Bytemine ($0.03), only if the cheap tier found nothing.
  let bytemineOk = false
  if (emails.length === 0) {
    const bm = await tryBytemine(cleanUrl)
    bytemineOk = bm.ok
    if (bm.ok) {
      spent += COST.bytemine
      providers.push('bytemine')
    }
    if (bm.emails.length > 0) emails = bm.emails
    if (bm.verified && bm.emails[0]) verifiedEmails.add(bm.emails[0])
    profile = mergeProfiles(profile, bm.profile)
  }

  // 7. Tier 3 — ContactOut ($0.33), last resort.
  let contactOutOk = false
  if (emails.length === 0) {
    const co = await tryContactOut(cleanUrl)
    contactOutOk = co.ok
    if (co.ok) {
      spent += COST.contactout
      providers.push('contactout')
    }
    if (co.emails.length > 0) emails = co.emails
  }

  // 8. Record spend (best-effort; the global cap is the real guard)
  if (spent > 0) {
    const { error } = await supabase
      .from('spend_log')
      .insert({ cost_cents: spent, providers: providers.join('+') })
    if (error) console.error('[lookup] spend_log insert failed:', error.message)
  }

  if (emails.length > 0) {
    // The badge applies to the primary (displayed) email only.
    const verified = verifiedEmails.has(emails[0])
    return NextResponse.json({ emails, profile, verified })
  }

  // 9. Distinguish a genuine miss from a system failure. If every provider we
  //    called errored, this is our problem, not "hard to find".
  const anyProviderResponded =
    oceanR.ok || aviatoR.ok || apolloR.ok || bytemineOk || contactOutOk
  if (!anyProviderResponded) {
    return NextResponse.json({ error: 'server' }, { status: 502 })
  }

  return NextResponse.json({ not_found: true })
}
