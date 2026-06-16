import { NextRequest, NextResponse } from 'next/server'
import { checkBotId } from 'botid/server'
import { createServiceClient } from '@/lib/supabase'
import { hashIdentity } from '@/lib/hash'
import { verifyVisitorCookie, signLookupToken, verifyLookupToken } from '@/lib/identity'

const ORTHOGONAL_URL = 'https://api.orthogonal.com/v1/run'
const RATE_LIMIT = 3 // per-visitor (signed cookie) lookups / 24h
// Hard ceiling per source IP / 24h, enforced in addition to RATE_LIMIT and
// independent of the cookie — so one attacker can't escape the limit by minting
// fresh cookies. Generous enough not to pinch big shared NATs (campus/office);
// the global spend cap is the real money guard, this just bounds single-source
// abuse. Tune down if you see IP-level hammering.
const IP_RATE_LIMIT = 30
const WINDOW_HOURS = 24

// The lookup is split into 3 separate HTTP calls (phase 1: Ocean ∥ Aviato ∥
// Apollo, phase 2: Bytemine, phase 3: ContactOut), the client driving each in
// turn only on a miss. Each phase is its own serverless function with its own
// 10s Vercel limit, so a slow provider no longer has to share one 10s window
// with the others — the previous cramming was what aborted live calls. Within a
// phase we still budget against a wall-clock deadline so we return clean JSON
// instead of letting Vercel hard-kill the function at 10s.
const PROVIDER_BUDGET_MS = 8500 // per-phase wall-clock for provider calls (<10s cap)
const TIER1_TIMEOUT_MS = 8000 // phase 1: Ocean ∥ Aviato ∥ Apollo (parallel)
const TIER2_TIMEOUT_MS = 8000 // phase 2: Bytemine
const TIER3_TIMEOUT_MS = 8000 // phase 3: ContactOut

// Cap the function at the Hobby maximum explicitly.
export const maxDuration = 10

// Hard global ceiling on credits the demo can spend in a rolling 24h, in cents.
// A backstop independent of the per-user limit: even if that's bypassed, total
// spend can't exceed this. Default $30/day; override with DAILY_BUDGET_CENTS.
const DAILY_BUDGET_CENTS = Number(process.env.DAILY_BUDGET_CENTS ?? 3000)

// Per-provider cost in cents (Orthogonal charges on a successful HTTP call,
// regardless of whether an email was found). Ocean bills ~$0.0045 in practice;
// rounded up to 1¢ so the budget cap errs high. ContactOut is $0.33 without
// phone (verified against the marketplace pricing formula).
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
  timeoutMs: number = TIER1_TIMEOUT_MS
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
  handle: string,
  timeoutMs: number
): Promise<{ ok: boolean; email: string | null; profile?: Profile }> {
  const { ok, data } = await callOrthogonal(
    'ocean-io',
    '/v2/lookup/people',
    {
      linkedinHandles: [handle],
      fields: ['name', 'jobTitle', 'headline', 'location', 'photo', 'email', 'email.address'],
    },
    'POST',
    timeoutMs
  )
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
async function tryAviato(
  linkedinUrl: string,
  timeoutMs: number
): Promise<{ ok: boolean; emails: string[] }> {
  const { ok, data } = await callOrthogonal(
    'aviato',
    '/person/contact-info',
    { linkedinURL: linkedinUrl },
    'GET',
    timeoutMs
  )
  const list = (data as { emails?: Array<{ email?: string; type?: string }> } | null)?.emails
  if (!Array.isArray(list)) return { ok, emails: [] }
  const work = list.filter((e) => e.type === 'work').map((e) => e.email)
  const other = list.filter((e) => e.type !== 'work').map((e) => e.email)
  return { ok, emails: Array.from(new Set([...work, ...other].filter(Boolean) as string[])) }
}

async function tryApollo(
  linkedinUrl: string,
  timeoutMs: number
): Promise<{ ok: boolean; email: string | null; verified: boolean; profile?: Profile }> {
  const { ok, data } = await callOrthogonal(
    'apollo',
    '/api/v1/people/match',
    { linkedin_url: linkedinUrl, reveal_personal_emails: false },
    'POST',
    timeoutMs
  )
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

async function tryContactOut(
  linkedinUrl: string,
  timeoutMs: number
): Promise<{ ok: boolean; emails: string[] }> {
  const { ok, data } = await callOrthogonal(
    'contactout',
    '/v1/people/linkedin',
    { profile: linkedinUrl },
    'GET',
    timeoutMs
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
  linkedinUrl: string,
  timeoutMs: number
): Promise<{ ok: boolean; emails: string[]; verified: boolean; profile?: Profile }> {
  const { ok, data } = await callOrthogonal(
    'bytemine',
    '/contacts/enrich',
    { linkedin: linkedinUrl },
    'POST',
    timeoutMs
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
  // Wall-clock start. This phase's provider timeouts are budgeted against it so
  // the gating work already spent counts against the 10s function limit.
  const t0 = Date.now()
  const timeLeft = () => PROVIDER_BUDGET_MS - (Date.now() - t0)

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  const { url, token, phase: rawPhase } = body as { url?: string; token?: string; phase?: number }
  const phase = rawPhase === 2 ? 2 : rawPhase === 3 ? 3 : 1
  // Trust only platform-set values. The first X-Forwarded-For hop is
  // client-supplied and trivially spoofable, so never key the rate limit on it;
  // Vercel populates request.ip / x-real-ip from the real connection.
  const ip = request.ip ?? request.headers.get('x-real-ip') ?? 'unknown'

  // 0. Reject cross-origin POSTs (all phases). Our UI always sends a same-origin
  //    request; a present, mismatched Origin is a direct/CSRF-style call.
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

  // 1. Validate the LinkedIn URL (all phases — cheap, no cost).
  if (typeof url !== 'string' || url.length > 2000) {
    return NextResponse.json({ invalid: true }, { status: 400 })
  }
  const cleanUrl = cleanLinkedInUrl(url)
  if (!cleanUrl) {
    return NextResponse.json({ invalid: true }, { status: 400 })
  }

  const supabase = createServiceClient()

  // 2. Gate. Phase 1 is the only entry point: it runs the bot check + rate limit
  //    and consumes the visitor's quota. Phases 2/3 are continuations that
  //    present the single-use token phase 1 issued — we redeem its nonce here so
  //    it can't be replayed to trigger repeat paid calls (esp. ContactOut).
  if (phase === 1) {
    const bot = await checkBotId({ advancedOptions: { checkLevel: 'basic' } })
    if (bot.isBot) {
      return NextResponse.json({ error: 'bot_blocked' }, { status: 403 })
    }

    // Atomic rate-limit check (advisory-locked count + insert): -1 if over.
    const checkLimit = async (identity: string, limit: number) => {
      const { data, error } = await supabase.rpc('check_and_log_attempt', {
        p_identity: identity,
        p_limit: limit,
        p_window_hours: WINDOW_HOURS,
      })
      if (error) {
        console.error('[lookup] rate-limit check failed:', error.message)
        return 'error' as const
      }
      return data === -1 ? ('limited' as const) : ('ok' as const)
    }

    // A signed httpOnly cookie identifies the visitor so distinct people behind
    // one NAT don't block each other. Because anyone can mint a fresh cookie, we
    // ALSO enforce a per-IP ceiling that cookie rotation can't escape — both must
    // have room. Cookieless clients collapse to a single, stricter IP bucket.
    const visitorId = await verifyVisitorCookie(request.cookies.get('lid')?.value)
    const ipIdentity = await hashIdentity(`ip:${ip}`)
    if (visitorId) {
      const ipResult = await checkLimit(ipIdentity, IP_RATE_LIMIT)
      if (ipResult === 'error') return NextResponse.json({ error: 'server' }, { status: 500 })
      if (ipResult === 'limited') return NextResponse.json({ rate_limited: true }, { status: 429 })

      const userResult = await checkLimit(await hashIdentity(`v:${visitorId}`), RATE_LIMIT)
      if (userResult === 'error') return NextResponse.json({ error: 'server' }, { status: 500 })
      if (userResult === 'limited') return NextResponse.json({ rate_limited: true }, { status: 429 })
    } else {
      const result = await checkLimit(ipIdentity, RATE_LIMIT)
      if (result === 'error') return NextResponse.json({ error: 'server' }, { status: 500 })
      if (result === 'limited') return NextResponse.json({ rate_limited: true }, { status: 429 })
    }
  } else {
    const tok = await verifyLookupToken(token, cleanUrl)
    if (!tok.valid || !tok.nonce) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const { data: fresh, error: nonceErr } = await supabase.rpc('consume_nonce', {
      p_nonce: tok.nonce,
    })
    if (nonceErr) {
      console.error('[lookup] nonce consume failed:', nonceErr.message)
      return NextResponse.json({ error: 'server' }, { status: 500 })
    }
    if (!fresh) {
      // Token already redeemed (replay).
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  // 3. Reserve this phase's worst-case cost atomically BEFORE spending, so a
  //    burst of concurrent requests can't read the same pre-spend total and
  //    collectively blow the cap. Reconciled to the real amount below.
  const phaseCost =
    phase === 1 ? COST.ocean + COST.aviato + COST.apollo : phase === 2 ? COST.bytemine : COST.contactout
  const { data: reservationId, error: resErr } = await supabase.rpc('reserve_spend', {
    p_window_hours: WINDOW_HOURS,
    p_budget_cents: DAILY_BUDGET_CENTS,
    p_reserve_cents: phaseCost,
  })
  if (resErr) {
    console.error('[lookup] budget reservation failed:', resErr.message)
    return NextResponse.json({ error: 'server' }, { status: 500 }) // fail closed
  }
  if (!reservationId) {
    return NextResponse.json({ at_capacity: true }, { status: 503 })
  }

  // 4. Run this phase's providers, each with (near) the full 10s function budget.
  let emails: string[] = []
  let profile: Profile | undefined
  let verified = false
  let spent = 0
  const providers: string[] = []
  let anyOk = false

  if (phase === 1) {
    // Three cheap providers in parallel ($0.01 each). Apollo and Ocean also
    // supply the profile card (Ocean takes the bare handle, the others the URL).
    const handle = cleanUrl.split('/in/')[1]
    const cap = Math.min(TIER1_TIMEOUT_MS, timeLeft())
    const [oceanR, aviatoR, apolloR] = await Promise.all([
      tryOcean(handle, cap),
      tryAviato(cleanUrl, cap),
      tryApollo(cleanUrl, cap),
    ])
    if (oceanR.ok) {
      spent += COST.ocean
      providers.push('ocean')
      anyOk = true
    }
    if (aviatoR.ok) {
      spent += COST.aviato
      providers.push('aviato')
      anyOk = true
    }
    if (apolloR.ok) {
      spent += COST.apollo
      providers.push('apollo')
      anyOk = true
    }
    profile = mergeProfiles(apolloR.profile, oceanR.profile)
    // Aviato lists work emails first, so keep its order ahead of the singletons.
    emails = Array.from(
      new Set([...aviatoR.emails, oceanR.email, apolloR.email].filter(Boolean) as string[])
    )
    // The badge applies only to the displayed email, and only Apollo vouches in
    // this phase.
    if (apolloR.verified && apolloR.email && emails[0] === apolloR.email) verified = true
  } else if (phase === 2) {
    const bm = await tryBytemine(cleanUrl, Math.min(TIER2_TIMEOUT_MS, timeLeft()))
    if (bm.ok) {
      spent += COST.bytemine
      providers.push('bytemine')
      anyOk = true
    }
    emails = bm.emails
    profile = bm.profile
    if (bm.verified && bm.emails[0]) verified = true
  } else {
    const co = await tryContactOut(cleanUrl, Math.min(TIER3_TIMEOUT_MS, timeLeft()))
    if (co.ok) {
      spent += COST.contactout
      providers.push('contactout')
      anyOk = true
    }
    emails = co.emails
  }

  // 5. Reconcile the reservation to what we actually spent (0 if the provider
  //    failed). Best-effort — a stale reservation just ages out of the window.
  const { error: reconErr } = await supabase.rpc('reconcile_spend', {
    p_id: reservationId,
    p_cost_cents: spent,
    p_providers: providers.join('+') || 'none',
  })
  if (reconErr) console.error('[lookup] spend reconcile failed:', reconErr.message)

  // 6. Respond.
  if (emails.length > 0) {
    return NextResponse.json({ emails, profile, verified })
  }
  if (phase < 3) {
    // No email yet — hand the client a fresh single-use token for the next tier,
    // and pass along any profile we gathered so it can accumulate across phases.
    const { token: nextToken } = await signLookupToken(cleanUrl)
    return NextResponse.json({ continue: true, phase: phase + 1, token: nextToken, profile })
  }
  // Phase 3 miss: distinguish a genuine "not found" from a provider failure.
  if (!anyOk) {
    return NextResponse.json({ error: 'server' }, { status: 502 })
  }
  return NextResponse.json({ not_found: true })
}
