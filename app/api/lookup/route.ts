import { NextRequest, NextResponse } from 'next/server'
import { checkBotId } from 'botid/server'
import { createServiceClient } from '@/lib/supabase'
import { hashIdentity } from '@/lib/hash'
import { verifyVisitorCookie, signLookupToken, verifyLookupToken } from '@/lib/identity'
import { Profile, mergeProfiles } from '@/lib/profile'

const ORTHOGONAL_URL = 'https://api.orthogonal.com/v1/run'
const RATE_LIMIT = 5 // per-visitor (signed cookie) successful lookups / 24h
// Hard ceiling per source IP / 24h, enforced in addition to RATE_LIMIT and
// independent of the cookie — so one attacker can't escape the limit by minting
// fresh cookies. Generous enough not to pinch big shared NATs (campus/office);
// the global spend cap is the real money guard, this just bounds single-source
// abuse. Tune down if you see IP-level hammering.
const IP_RATE_LIMIT = 30
const WINDOW_HOURS = 24

// The lookup is split into 2 separate HTTP calls (phase 1: Apollo ∥ Tomba ∥
// Bytemine, +Aviato only on a miss; phase 2: ContactOut), the client driving
// phase 2 only if phase 1 fully misses. Each phase is its own serverless
// function with its own 10s Vercel limit, so a slow provider no longer has to
// share one 10s window with the others — the previous cramming was what
// aborted live calls. Within a phase we still budget against a wall-clock
// deadline so we return clean JSON instead of letting Vercel hard-kill the
// function at 10s.
const PROVIDER_BUDGET_MS = 8500 // per-phase wall-clock for provider calls (<10s cap)
const TIER1_TIMEOUT_MS = 8000 // phase 1: Apollo ∥ Tomba ∥ Bytemine, then Aviato if all three miss
const TIER2_TIMEOUT_MS = 8000 // phase 2: ContactOut

// Cap the function at the Hobby maximum explicitly.
export const maxDuration = 10

// Hard global ceiling on credits the demo can spend in a rolling 24h, in cents.
// A backstop independent of the per-user limit: even if that's bypassed, total
// spend can't exceed this. Default $30/day; override with DAILY_BUDGET_CENTS.
const DAILY_BUDGET_CENTS = Number(process.env.DAILY_BUDGET_CENTS ?? 3000)

// Per-provider cost in cents (Orthogonal charges on a successful HTTP call,
// regardless of whether an email was found). ContactOut is $0.33 without phone
// (verified against the marketplace pricing formula). Tomba's $0.01 is
// confirmed against the Orthogonal marketplace listing (flat price, not
// dynamic) and against a live test call (2026-08-31) that returned real data
// in the exact shape `tryTomba` parses — see that function.
//
// Provider choice is data-driven, not guessed: the founder-email-waterfall
// skill's 395-row audit of these same Orthogonal-wrapped providers found
// Apollo ~55% hit rate (100% verified-when-hit), Tomba ~27% (100% verified,
// Apollo+Tomba = ~82% combined), Aviato ~2% (only 25% of those verified, and
// it contributes no profile-card fields — see tryAviato). So Apollo+Tomba
// anchor the always-on tier; Aviato is demoted to fallback-only. Ocean.io held
// the 4th always-on slot until dropped from the marketplace (2026-08) — Tomba
// replaces it, in the stronger role the audit data actually supports.
//
// Caveat on "100% verified": that's the waterfall skill's own acceptance rule
// (domain matched a known company_website), not Tomba's self-reported
// `verification.status` field. A live test here caught Tomba returning
// `status: "valid"` on a stale match (wrong company, gmail address) — so this
// route never treats that field as a verification signal (see verifiedEmails
// below); the "100%" figure describes accepted matches, not raw hits.
const COST = { apollo: 1, tomba: 1, aviato: 1, bytemine: 3, contactout: 33 }

// Normalize any LinkedIn URL variant to https://www.linkedin.com/in/slug
function cleanLinkedInUrl(input: string): string | null {
  const match = input.trim().match(/linkedin\.com\/in\/([a-zA-Z0-9_-]+)/i)
  if (!match) return null
  return `https://www.linkedin.com/in/${match[1]}`
}

// Free consumer webmail domains — anything NOT in this set (a company domain,
// a .edu, a personal-but-vanity domain) counts as "professional" for ranking.
// Providers' own work/personal tags are inconsistent (a .edu address sometimes
// comes back untyped, or mistyped as personal), so we classify by domain
// ourselves instead of trusting each provider's label.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'rocketmail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.com',
  'msn.com', 'aol.com', 'aim.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'fastmail.com', 'hushmail.com', 'gmx.com',
  'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru',
  'qq.com', '163.com', '126.com', 'naver.com', 'rediffmail.com', 'web.de',
  't-online.de', 'seznam.cz', 'wp.pl', 'o2.pl', 'orange.fr', 'free.fr',
  'laposte.net', 'libero.it',
  // Residential ISP webmail — same "not a workplace address" category as the
  // big consumer brands above, just less common. Caught a real gap here: a
  // .edu vs. earthlink.net test case only ranked correctly because a provider
  // happened to tag the .edu address "verified" — this list should classify
  // it correctly on its own, not rely on that being true every time.
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'earthlink.net',
  'cox.net', 'charter.net', 'spectrum.net', 'centurylink.net', 'frontier.com',
  'frontiernet.net', 'windstream.net', 'bellsouth.net', 'roadrunner.com',
  'rr.com', 'embarqmail.com', 'netzero.net', 'juno.com', 'optonline.net',
  'suddenlink.net', 'shaw.ca', 'sympatico.ca', 'rogers.com', 'telus.net',
])

function isPersonalDomain(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  return FREE_EMAIL_DOMAINS.has(domain)
}

// Ranks candidate emails so a real professional address (company domain, .edu,
// anything not free consumer webmail) always beats a personal one for the
// primary slot, regardless of which provider returned it first. Verified
// addresses break ties within a tier; original provider-priority order is the
// final tiebreak. Personal addresses aren't dropped — they just sort after,
// so they still show up in the "more info" dropdown.
function rankEmails(candidates: string[], verifiedEmails: Set<string>): string[] {
  return candidates
    .map((email, i) => ({ email, i }))
    .sort((a, b) => {
      const aPersonal = isPersonalDomain(a.email)
      const bPersonal = isPersonalDomain(b.email)
      if (aPersonal !== bPersonal) return aPersonal ? 1 : -1
      const aVerified = verifiedEmails.has(a.email)
      const bVerified = verifiedEmails.has(b.email)
      if (aVerified !== bVerified) return aVerified ? -1 : 1
      return a.i - b.i
    })
    .map((x) => x.email)
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
): Promise<{ ok: boolean; responded: boolean; data: unknown }> {
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
    // `responded` = the provider gave us a definitive answer, so a miss is a real
    // "not found" rather than an outage (it gates not_found vs a 502). A 404 means
    // "no record for this profile": responded, but a clean miss — not ok (no data)
    // and not billable ($0). Only a timeout / 5xx / network error is !responded.
    if (res.status === 404) {
      return { ok: false, responded: true, data: null }
    }
    if (!res.ok) {
      console.error(`[orthogonal] ${api}${path} → HTTP ${res.status}`)
      return { ok: false, responded: false, data: null }
    }
    const json = await res.json()
    return { ok: true, responded: true, data: (json as { data?: unknown })?.data ?? json }
  } catch (err) {
    console.error(`[orthogonal] ${api}${path} → ${(err as Error).name}`)
    return { ok: false, responded: false, data: null }
  }
}

// Tomba wants the full profile URL (unlike Ocean, which took a bare handle).
// No photo/company-logo/size/industry in the response — Apollo and Bytemine
// already cover those in mergeProfiles, so this only contributes name/title/
// location/company plus its own independent shot at the email.
async function tryTomba(
  linkedinUrl: string,
  timeoutMs: number
): Promise<{ ok: boolean; responded: boolean; email: string | null; profile?: Profile }> {
  const { ok, responded, data } = await callOrthogonal(
    'tomba',
    '/v1/linkedin',
    { url: linkedinUrl },
    'GET',
    timeoutMs
  )
  const person = (data as { data?: Record<string, unknown> } | null)?.data
  if (!person) return { ok, responded, email: null }

  const email = (person.email as string) || null
  const profile: Profile = {
    name: (person.full_name as string) ?? undefined,
    title: (person.position as string) ?? undefined,
    location: (person.country as string) ?? undefined,
    company: (person.company as string) ?? undefined,
  }
  return { ok, responded, email, profile: profile.name || profile.title ? profile : undefined }
}

// Aviato returns a typed email list; work emails are preferred (work finder).
// Weakest of the four sources (see COST comment) — called fallback-only.
async function tryAviato(
  linkedinUrl: string,
  timeoutMs: number
): Promise<{ ok: boolean; responded: boolean; emails: string[] }> {
  const { ok, responded, data } = await callOrthogonal(
    'aviato',
    '/person/contact-info',
    { linkedinURL: linkedinUrl },
    'GET',
    timeoutMs
  )
  const list = (data as { emails?: Array<{ email?: string; type?: string }> } | null)?.emails
  if (!Array.isArray(list)) return { ok, responded, emails: [] }
  const work = list.filter((e) => e.type === 'work').map((e) => e.email)
  const other = list.filter((e) => e.type !== 'work').map((e) => e.email)
  return { ok, responded, emails: Array.from(new Set([...work, ...other].filter(Boolean) as string[])) }
}

async function tryApollo(
  linkedinUrl: string,
  timeoutMs: number
): Promise<{
  ok: boolean
  responded: boolean
  email: string | null
  personalEmails: string[]
  verified: boolean
  profile?: Profile
}> {
  const { ok, responded, data } = await callOrthogonal(
    'apollo',
    '/api/v1/people/match',
    { linkedin_url: linkedinUrl, reveal_personal_emails: true },
    'POST',
    timeoutMs
  )
  const person = (data as { person?: Record<string, unknown> } | null)?.person
  if (!person) return { ok, responded, email: null, personalEmails: [], verified: false }

  // With reveal_personal_emails, Apollo returns personal addresses in a separate
  // array (work email stays in `email`).
  const personalEmails = Array.isArray(person.personal_emails)
    ? (person.personal_emails as unknown[]).filter((e): e is string => typeof e === 'string')
    : []

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
    responded,
    email: (person.email as string) || null,
    personalEmails,
    // Apollo tags each email: "verified" | "guessed" | "unavailable" | null.
    verified: (person.email_status as string) === 'verified',
    profile: profile.name || profile.title ? profile : undefined,
  }
}

async function tryContactOut(
  linkedinUrl: string,
  timeoutMs: number
): Promise<{ ok: boolean; responded: boolean; emails: string[] }> {
  const { ok, responded, data } = await callOrthogonal(
    'contactout',
    '/v1/people/linkedin',
    { profile: linkedinUrl },
    'GET',
    timeoutMs
  )
  const p = (data as { profile?: { work_email?: string[]; email?: string[] } } | null)?.profile
  if (!p) return { ok, responded, emails: [] }
  // Work emails first — this is a work-email finder.
  const workEmails = Array.isArray(p.work_email) ? p.work_email : []
  const anyEmails = Array.isArray(p.email) ? p.email : []
  return { ok, responded, emails: Array.from(new Set([...workEmails, ...anyEmails])).filter(Boolean) }
}

// Bytemine: cheap-ish ($0.03) mid-tier. Returns a verified work email plus
// profile data (no photo), so it can also backfill the card if Tomba/Apollo miss.
async function tryBytemine(
  linkedinUrl: string,
  timeoutMs: number
): Promise<{
  ok: boolean
  responded: boolean
  emails: string[]
  verified: boolean
  verifiedEmail: string | null
  profile?: Profile
}> {
  const { ok, responded, data } = await callOrthogonal(
    'bytemine',
    '/contacts/enrich',
    { linkedin: linkedinUrl },
    'POST',
    timeoutMs
  )
  const d = data as Record<string, unknown> | null
  if (!d) return { ok, responded, emails: [], verified: false, verifiedEmail: null }

  const work = (d.work_email as string) || (d.email as string) || null
  const personal = (d.personal_email as string) || null
  const emails = Array.from(new Set([work, personal].filter(Boolean) as string[]))

  // Bytemine's SMTP check validates the WORK email specifically (see its own
  // comment below) — `verified` must only ever point at `work`, never at
  // `emails[0]`, which silently becomes the personal address whenever `work`
  // is missing and would otherwise mislabel it as SMTP-verified.
  const ef = d.email_finder as { smtp_result?: string; confidence?: string } | undefined
  const verified = Boolean(work) && (ef?.smtp_result === 'valid' || ef?.confidence === 'high')

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
  return {
    ok,
    responded,
    emails,
    verified,
    verifiedEmail: verified ? work : null,
    profile: profile.name || profile.title ? profile : undefined,
  }
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
  // t0 is set just before provider calls (step 4) so the provider timeout budget
  // isn't eaten by BotID + Supabase gating overhead. Declared here so TypeScript
  // sees it in scope; assigned after gating completes.
  let t0 = 0
  const timeLeft = () => PROVIDER_BUDGET_MS - (Date.now() - t0)

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  const { url, token, phase: rawPhase } = body as { url?: string; token?: string; phase?: number }
  const phase = rawPhase === 2 ? 2 : 1
  // Trust only platform-set values. The first X-Forwarded-For hop is
  // client-supplied and trivially spoofable, so never key the rate limit on it;
  // Vercel populates x-real-ip from the real connection. (Next.js 15 dropped
  // request.ip, which used to read the same value.)
  const ip = request.headers.get('x-real-ip') ?? 'unknown'

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

  // Visitor identity (signed httpOnly cookie), resolved in every phase so a
  // successful lookup can be recorded against the per-visitor quota below.
  const visitorId = await verifyVisitorCookie(request.cookies.get('lid')?.value)
  const visitorIdentity = visitorId ? await hashIdentity(`v:${visitorId}`) : null

  // 2. Gate. Phase 1 is the only entry point: it runs the bot check + rate limit.
  //    Phases 2/3 are continuations that present the single-use token phase 1
  //    issued — we redeem its nonce here so it can't be replayed to trigger
  //    repeat paid calls (esp. ContactOut).
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

    // Per-IP ceiling counts EVERY attempt (success or miss). This is the cost
    // backstop and the real abuse bound — it's what keeps "misses don't count"
    // safe, since a flood of not-found lookups still spends money. Cookieless
    // clients have no per-visitor quota, so they collapse to a single strict IP
    // bucket (every attempt counts).
    const ipIdentity = await hashIdentity(`ip:${ip}`)
    const ipResult = await checkLimit(ipIdentity, visitorIdentity ? IP_RATE_LIMIT : RATE_LIMIT)
    if (ipResult === 'error') return NextResponse.json({ error: 'server' }, { status: 500 })
    if (ipResult === 'limited') return NextResponse.json({ rate_limited: true }, { status: 429 })

    if (visitorIdentity) {
      // Per-visitor quota counts only SUCCESSFUL lookups, so a "not found" never
      // burns one of the visitor's free searches. Read-only here — the success
      // row is written once an email is actually returned (step 6).
      const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString()
      const { count, error } = await supabase
        .from('attempts')
        .select('id', { count: 'exact', head: true })
        .eq('user_hash', visitorIdentity)
        .gte('created_at', since)
      if (error) {
        console.error('[lookup] success-count check failed:', error.message)
        return NextResponse.json({ error: 'server' }, { status: 500 })
      }
      if ((count ?? 0) >= RATE_LIMIT) {
        return NextResponse.json({ rate_limited: true }, { status: 429 })
      }
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
    phase === 1 ? COST.tomba + COST.aviato + COST.apollo + COST.bytemine : COST.contactout
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

  // 4. Run this phase's providers. Start the stopwatch NOW — after all gating —
  //    so BotID + Supabase overhead doesn't eat into the provider time budget.
  t0 = Date.now()
  let emails: string[] = []
  let profile: Profile | undefined
  let verified = false
  let spent = 0
  const providers: string[] = []
  let anyOk = false

  if (phase === 1) {
    // Three providers in parallel: Apollo, Tomba ($0.01 each) + Bytemine
    // ($0.03) — $0.05 flat. These are the two strongest email sources (see the
    // COST comment above) plus the strong, cheap-ish Bytemine — run here
    // (rather than as a fallback) to raise hit quality without paying for the
    // $0.33 ContactOut tier. Apollo/Bytemine also supply the profile card.
    const cap = Math.min(TIER1_TIMEOUT_MS, timeLeft())
    const [apolloR, tombaR, bmR] = await Promise.all([
      tryApollo(cleanUrl, cap),
      tryTomba(cleanUrl, cap),
      tryBytemine(cleanUrl, cap),
    ])
    if (apolloR.ok) {
      spent += COST.apollo
      providers.push('apollo')
    }
    if (tombaR.ok) {
      spent += COST.tomba
      providers.push('tomba')
    }
    if (bmR.ok) {
      spent += COST.bytemine
      providers.push('bytemine')
    }
    // "Responded" includes a clean 404 (no data) — only a true error (timeout /
    // 5xx / network) leaves it false, which is what distinguishes not_found from
    // a 502.
    anyOk = apolloR.responded || tombaR.responded || bmR.responded
    profile = mergeProfiles(apolloR.profile, tombaR.profile, bmR.profile)
    let rawEmails = [
      tombaR.email,
      ...bmR.emails,
      apolloR.email,
      ...apolloR.personalEmails,
    ].filter(Boolean) as string[]
    // The badge applies only to the displayed email — set it when that address is
    // one Apollo (email_status) or Bytemine (SMTP check) vouched for. Tomba is
    // deliberately never added here: a live test caught it reporting its own
    // `verification.status: "valid"` on a stale/wrong match (see COST comment),
    // so treating that field as a verification signal would be actively
    // misleading, not just uninformative.
    const verifiedEmails = new Set<string>()
    if (apolloR.verified && apolloR.email) verifiedEmails.add(apolloR.email)
    if (bmR.verifiedEmail) verifiedEmails.add(bmR.verifiedEmail)

    // Aviato is the weakest of the four (~2% hit rate, only 25% verified per
    // the founder-email-waterfall audit) and supplies no profile fields at
    // all, so it's a fallback-only last shot — it only fires when the three
    // strong providers above found nothing, not an always-on 4th guess. Same
    // outcome as before on a full miss (falls through to phase 2 either way),
    // just cheaper on the common case.
    if (rawEmails.length === 0) {
      const aviatoCap = Math.min(TIER1_TIMEOUT_MS, timeLeft())
      const aviatoR = await tryAviato(cleanUrl, aviatoCap)
      if (aviatoR.ok) {
        spent += COST.aviato
        providers.push('aviato')
      }
      anyOk = anyOk || aviatoR.responded
      rawEmails = aviatoR.emails
    }

    emails = rankEmails(Array.from(new Set(rawEmails)), verifiedEmails)
    verified = emails.length > 0 && verifiedEmails.has(emails[0])
  } else {
    const co = await tryContactOut(cleanUrl, Math.min(TIER2_TIMEOUT_MS, timeLeft()))
    if (co.ok) {
      spent += COST.contactout
      providers.push('contactout')
    }
    anyOk = co.responded
    // Same domain-quality ranking as phase 1 — ContactOut's own work/personal
    // split has the same mislabeling risk (e.g. a .edu address).
    emails = rankEmails(co.emails, new Set())
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
    // Count this success against the per-visitor quota (RATE_LIMIT/day), in
    // whichever phase found the email. Go through the SAME advisory-locked
    // count+insert RPC as the IP bucket, not a bare insert: the phase-1 query is
    // only a cheap fast-fail, so without serialization here concurrent winning
    // lookups from one cookie could all pass that read and overshoot the cap.
    if (visitorIdentity) {
      const { data: logged, error } = await supabase.rpc('check_and_log_attempt', {
        p_identity: visitorIdentity,
        p_limit: RATE_LIMIT,
        p_window_hours: WINDOW_HOURS,
      })
      // -1 = the visitor raced past their quota while this lookup was in flight;
      // honor the limit rather than hand out an uncounted free lookup. A bare RPC
      // error stays best-effort — don't deny an already-paid-for result over a
      // transient logging blip.
      if (error) console.error('[lookup] success log failed:', error.message)
      else if (logged === -1) return NextResponse.json({ rate_limited: true }, { status: 429 })
    }
    return NextResponse.json({ emails, profile, verified })
  }
  if (phase < 2) {
    // A phase-1 miss where NO provider even responded is an outage, not a "hard
    // to find" — surface it as a 502 now instead of paying for the $0.33
    // ContactOut tier and then masking the failure as not_found at phase 2.
    if (!anyOk) {
      return NextResponse.json({ error: 'server' }, { status: 502 })
    }
    // No email yet — hand the client a fresh single-use token for the ContactOut
    // phase, and pass along any profile we gathered so it can accumulate.
    const { token: nextToken } = await signLookupToken(cleanUrl)
    return NextResponse.json({ continue: true, phase: phase + 1, token: nextToken, profile })
  }
  // Phase 2 miss: distinguish a genuine "not found" from a provider failure.
  if (!anyOk) {
    return NextResponse.json({ error: 'server' }, { status: 502 })
  }
  return NextResponse.json({ not_found: true })
}
