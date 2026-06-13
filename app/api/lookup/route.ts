import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { hashIdentity } from '@/lib/hash'

const ORTHOGONAL_URL = 'https://mcp.orthogonal.com'
const RATE_LIMIT = 3
const WINDOW_HOURS = 24

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      secret: process.env.TURNSTILE_SECRET_KEY!,
      response: token,
      remoteip: ip,
    }),
  })
  const data = await res.json()
  return data.success === true
}

// Orthogonal wraps all responses: { success, data: <provider response>, payment, ... }
async function callOrthogonal(api: string, path: string, params: Record<string, unknown>) {
  const res = await fetch(ORTHOGONAL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ORTHOGONAL_API_KEY}`,
    },
    body: JSON.stringify({ api, path, params }),
  })
  if (!res.ok) return null
  const json = await res.json()
  // Unwrap the Orthogonal envelope — actual provider response is in json.data
  return json?.data ?? json
}

// Step 1: Tomba — $0.01. Response: { data: { email } }
async function tryTomba(linkedinUrl: string): Promise<string | null> {
  const data = await callOrthogonal('tomba', '/v1/linkedin', { url: linkedinUrl })
  if (!data) return null
  const email = data?.data?.email ?? data?.email ?? null
  return email || null
}

// Step 2: Apollo — $0.01. Response: { person: { email, email_status } }
async function tryApollo(linkedinUrl: string): Promise<string | null> {
  const data = await callOrthogonal('apollo', '/api/v1/people/match', {
    linkedin_url: linkedinUrl,
    reveal_personal_emails: false,
  })
  if (!data) return null
  const email = data?.person?.email ?? null
  return email || null
}

// Step 3: ContactOut — $0.33. Response: { profile: { work_email: [], email: [] } }
// Prefers verified work email, falls back to any email found.
async function tryContactOut(linkedinUrl: string): Promise<string | null> {
  const data = await callOrthogonal('contactout', '/v1/people/linkedin', {
    profile: linkedinUrl,
  })
  if (!data) return null
  const profile = data?.profile
  if (!profile) return null
  const workEmail = Array.isArray(profile.work_email) ? profile.work_email[0] : null
  const anyEmail = Array.isArray(profile.email) ? profile.email[0] : null
  return workEmail ?? anyEmail ?? null
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }

  const { url, turnstileToken } = body as { url?: string; turnstileToken?: string }
  const fingerprint = request.headers.get('x-fingerprint') ?? ''
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'

  // 1. Validate LinkedIn URL
  if (!url || !url.includes('linkedin.com/in/')) {
    return NextResponse.json({ invalid: true }, { status: 400 })
  }

  // 2. Verify Turnstile (skip in dev when key is missing)
  if (process.env.TURNSTILE_SECRET_KEY) {
    const valid = await verifyTurnstile(turnstileToken ?? '', ip)
    if (!valid) {
      return NextResponse.json({ error: 'captcha_failed' }, { status: 400 })
    }
  }

  // 3. Hash user identity
  const userHash = await hashIdentity(ip, fingerprint)

  // 4. Check rate limit
  const supabase = createServiceClient()
  const windowStart = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const { count } = await supabase
    .from('attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_hash', userHash)
    .gt('created_at', windowStart)

  if ((count ?? 0) >= RATE_LIMIT) {
    return NextResponse.json({ rate_limited: true }, { status: 429 })
  }

  // 5. Log attempt
  await supabase.from('attempts').insert({ user_hash: userHash })

  // 6. Tomba ($0.01)
  const tombaEmail = await tryTomba(url)
  if (tombaEmail) return NextResponse.json({ email: tombaEmail })

  // 7. Apollo ($0.01)
  const apolloEmail = await tryApollo(url)
  if (apolloEmail) return NextResponse.json({ email: apolloEmail })

  // 8. ContactOut ($0.33)
  const contactOutEmail = await tryContactOut(url)
  if (contactOutEmail) return NextResponse.json({ email: contactOutEmail })

  // 9. Not found
  return NextResponse.json({ not_found: true })
}
