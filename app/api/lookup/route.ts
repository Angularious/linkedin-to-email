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

async function callOrthogonal(api: string, path: string, params: Record<string, string>) {
  const res = await fetch(ORTHOGONAL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ORTHOGONAL_API_KEY}`,
    },
    body: JSON.stringify({ api, path, params }),
  })
  if (!res.ok) return null
  return res.json()
}

async function tryTomba(linkedinUrl: string): Promise<string | null> {
  const data = await callOrthogonal('tomba', '/v1/linkedin', { url: linkedinUrl })
  if (!data) return null
  return (
    data?.data?.email ||
    data?.result?.email ||
    data?.email ||
    null
  )
}

async function tryApollo(linkedinUrl: string): Promise<string | null> {
  const data = await callOrthogonal('apollo', '/api/v1/people/match', {
    linkedin_url: linkedinUrl,
    reveal_personal_emails: 'false',
  })
  if (!data) return null
  return (
    data?.person?.email ||
    data?.result?.email ||
    data?.email ||
    null
  )
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

  // 6. Tomba
  const tombaEmail = await tryTomba(url)
  if (tombaEmail) return NextResponse.json({ email: tombaEmail })

  // 7. Apollo
  const apolloEmail = await tryApollo(url)
  if (apolloEmail) return NextResponse.json({ email: apolloEmail })

  // 8. Not found
  return NextResponse.json({ not_found: true })
}
