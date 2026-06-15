import { NextRequest, NextResponse } from 'next/server'
import { checkBotId } from 'botid/server'
import { createServiceClient } from '@/lib/supabase'
import { hashIdentity } from '@/lib/hash'
import { verifyVisitorCookie } from '@/lib/identity'

const ORTHOGONAL_URL = 'https://api.orthogonal.com/v1/run'
const RATE_LIMIT = 3
const WINDOW_HOURS = 24
const PROVIDER_TIMEOUT_MS = 8000

// Hard global ceiling on credits the demo can spend in a rolling 24h, in cents.
// A backstop independent of the per-user limit: even if that's bypassed, total
// spend can't exceed this. Default $25/day; override with DAILY_BUDGET_CENTS.
const DAILY_BUDGET_CENTS = Number(process.env.DAILY_BUDGET_CENTS ?? 2500)

// Per-provider cost in cents (Orthogonal charges on a successful HTTP call,
// regardless of whether an email was found).
const COST = { tomba: 1, apollo: 1, contactout: 33 }

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
  httpMethod: 'GET' | 'POST' = 'POST'
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
      PROVIDER_TIMEOUT_MS
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
  company?: string
  photoUrl?: string
}

async function tryTomba(linkedinUrl: string): Promise<{ ok: boolean; email: string | null }> {
  const { ok, data } = await callOrthogonal('tomba', '/v1/linkedin', { url: linkedinUrl }, 'GET')
  const d = data as { data?: { email?: string }; email?: string } | null
  const email = d?.data?.email ?? d?.email ?? null
  return { ok, email: email || null }
}

async function tryApollo(
  linkedinUrl: string
): Promise<{ ok: boolean; email: string | null; profile?: Profile }> {
  const { ok, data } = await callOrthogonal('apollo', '/api/v1/people/match', {
    linkedin_url: linkedinUrl,
    reveal_personal_emails: false,
  })
  const person = (data as { person?: Record<string, unknown> } | null)?.person
  if (!person) return { ok, email: null }

  const org = person.organization as { name?: string } | undefined
  const profile: Profile = {
    name: (person.name as string) ?? undefined,
    title: (person.title as string) ?? undefined,
    company: org?.name ?? undefined,
    photoUrl: (person.photo_url as string) ?? undefined,
  }

  return {
    ok,
    email: (person.email as string) || null,
    profile: profile.name || profile.title ? profile : undefined,
  }
}

async function tryContactOut(linkedinUrl: string): Promise<{ ok: boolean; emails: string[] }> {
  const { ok, data } = await callOrthogonal(
    'contactout',
    '/v1/people/linkedin',
    { profile: linkedinUrl },
    'GET'
  )
  const p = (data as { profile?: { work_email?: string[]; email?: string[] } } | null)?.profile
  if (!p) return { ok, emails: [] }
  // Work emails first — this is a work-email finder.
  const workEmails = Array.isArray(p.work_email) ? p.work_email : []
  const anyEmails = Array.isArray(p.email) ? p.email : []
  return { ok, emails: Array.from(new Set([...workEmails, ...anyEmails])).filter(Boolean) }
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

  // 1. Clean + validate LinkedIn URL (no cost, no DB — reject junk early)
  const cleanUrl = url ? cleanLinkedInUrl(url) : null
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

  // 2. Global budget check BEFORE consuming the user's quota, so a user who
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

  // 5. Tomba + Apollo in parallel ($0.01 each)
  const [tombaR, apolloR] = await Promise.all([tryTomba(cleanUrl), tryApollo(cleanUrl)])

  let spent = (tombaR.ok ? COST.tomba : 0) + (apolloR.ok ? COST.apollo : 0)
  const providers: string[] = []
  if (tombaR.ok) providers.push('tomba')
  if (apolloR.ok) providers.push('apollo')

  const profile = apolloR.profile
  let emails = Array.from(
    new Set([tombaR.email, apolloR.email].filter(Boolean) as string[])
  )

  // 6. ContactOut fallback ($0.33) only if the cheap providers found nothing
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

  // 7. Record spend (best-effort; the global cap is the real guard)
  if (spent > 0) {
    const { error } = await supabase
      .from('spend_log')
      .insert({ cost_cents: spent, providers: providers.join('+') })
    if (error) console.error('[lookup] spend_log insert failed:', error.message)
  }

  if (emails.length > 0) {
    return NextResponse.json({ emails, profile })
  }

  // 8. Distinguish a genuine miss from a system failure. If every provider we
  //    called errored, this is our problem, not "hard to find".
  const anyProviderResponded = tombaR.ok || apolloR.ok || contactOutOk
  if (!anyProviderResponded) {
    return NextResponse.json({ error: 'server' }, { status: 502 })
  }

  return NextResponse.json({ not_found: true })
}
