import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase'
import { hashIdentity } from '@/lib/hash'

const ORTHOGONAL_URL = 'https://api.orthogonal.com/v1/run'
const RATE_LIMIT = 3
const WINDOW_HOURS = 24

// Normalize any LinkedIn URL variant to https://www.linkedin.com/in/slug
function cleanLinkedInUrl(input: string): string | null {
  const match = input.trim().match(/linkedin\.com\/in\/([a-zA-Z0-9_-]+)/i)
  if (!match) return null
  return `https://www.linkedin.com/in/${match[1]}`
}

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
    body: JSON.stringify({ api, path, body: params }),
  })
  if (!res.ok) return null
  const json = await res.json()
  return json?.data ?? json
}

interface Profile {
  name?: string
  title?: string
  company?: string
  photoUrl?: string
}

async function tryTomba(linkedinUrl: string): Promise<{ email: string | null }> {
  const data = await callOrthogonal('tomba', '/v1/linkedin', { url: linkedinUrl })
  if (!data) return { email: null }
  const email = data?.data?.email ?? data?.email ?? null
  return { email: email || null }
}

async function tryApollo(linkedinUrl: string): Promise<{ email: string | null; profile?: Profile }> {
  const data = await callOrthogonal('apollo', '/api/v1/people/match', {
    linkedin_url: linkedinUrl,
    reveal_personal_emails: false,
  })
  if (!data) return { email: null }
  const person = data?.person
  if (!person) return { email: null }

  const profile: Profile = {
    name: person.name ?? undefined,
    title: person.title ?? undefined,
    company: person.organization?.name ?? undefined,
    photoUrl: person.photo_url ?? undefined,
  }

  return {
    email: person.email || null,
    profile: profile.name || profile.title ? profile : undefined,
  }
}

async function tryContactOut(linkedinUrl: string): Promise<{ emails: string[] }> {
  const data = await callOrthogonal('contactout', '/v1/people/linkedin', {
    profile: linkedinUrl,
  })
  if (!data) return { emails: [] }
  const p = data?.profile
  if (!p) return { emails: [] }
  const workEmails: string[] = Array.isArray(p.work_email) ? p.work_email : []
  const anyEmails: string[] = Array.isArray(p.email) ? p.email : []
  return { emails: Array.from(new Set([...workEmails, ...anyEmails])).filter(Boolean) }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'bad_request' }, { status: 400 })

  const { url, turnstileToken } = body as { url?: string; turnstileToken?: string }
  const fingerprint = request.headers.get('x-fingerprint') ?? ''
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'

  // 1. Clean + validate LinkedIn URL
  const cleanUrl = url ? cleanLinkedInUrl(url) : null
  if (!cleanUrl) {
    return NextResponse.json({ invalid: true }, { status: 400 })
  }

  // 2. Verify Turnstile (skip in dev when key is missing)
  if (process.env.TURNSTILE_SECRET_KEY) {
    const valid = await verifyTurnstile(turnstileToken ?? '', ip)
    if (!valid) return NextResponse.json({ error: 'captcha_failed' }, { status: 400 })
  }

  // 3. Hash user identity + check rate limit
  const userHash = await hashIdentity(ip, fingerprint)
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

  // 4. Log attempt
  await supabase.from('attempts').insert({ user_hash: userHash })

  // 5. Tomba + Apollo in parallel ($0.01 each)
  const [tombaResult, apolloResult] = await Promise.allSettled([
    tryTomba(cleanUrl),
    tryApollo(cleanUrl),
  ])

  const tombaEmail = tombaResult.status === 'fulfilled' ? tombaResult.value.email : null
  const apolloEmail = apolloResult.status === 'fulfilled' ? apolloResult.value.email : null
  const profile = apolloResult.status === 'fulfilled' ? apolloResult.value.profile : undefined

  const emails = Array.from(new Set([tombaEmail, apolloEmail].filter(Boolean) as string[]))

  if (emails.length > 0) {
    return NextResponse.json({ emails, profile })
  }

  // 6. ContactOut fallback ($0.33)
  const contactOut = await tryContactOut(cleanUrl)
  if (contactOut.emails.length > 0) {
    return NextResponse.json({ emails: contactOut.emails, profile })
  }

  return NextResponse.json({ not_found: true })
}
