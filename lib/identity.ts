// Server-signed visitor identity.
//
// We issue each browser an HMAC-signed, httpOnly cookie (see middleware.ts)
// and key the rate limit on it. The client can't forge a valid cookie (no
// signing secret) and page JS can't read it (httpOnly), so distinct real
// people on a shared IP — students on campus WiFi, coworkers behind one NAT —
// each get their own quota instead of colliding on the IP.
//
// This is NOT the abuse defense (the global spend cap and per-identity rate
// limit are; platform-level bot protection runs in front via Vercel). An
// abuser can still mint cookies by reloading the page, but total spend is
// bounded by the daily cap regardless. The cookie's job is purely to stop
// legitimate users from blocking each other on a shared IP.

const enc = new TextEncoder()

function signingSecret(): string {
  return (
    process.env.IDENTITY_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY || // always set in prod; fine as a fallback
    'dev-only-insecure-secret'
  )
}

async function hmacHex(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(signingSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function newVisitorId(): string {
  return crypto.randomUUID()
}

export async function signVisitorId(id: string): Promise<string> {
  return `${id}.${await hmacHex(id)}`
}

// ── Continuation token for the phased lookup ──
// Binds a single-use nonce to the cleaned URL with a short expiry, signed with
// the same secret as visitor cookies. Phases 2/3 of a lookup present this instead
// of re-running the bot check / rate limit; the nonce is redeemed server-side
// (see consume_nonce) so the token can't be replayed to repeat paid calls.
const LOOKUP_TOKEN_TTL_MS = 60_000

export async function signLookupToken(cleanUrl: string): Promise<{ token: string; nonce: string }> {
  const nonce = crypto.randomUUID()
  const expiry = Date.now() + LOOKUP_TOKEN_TTL_MS
  const sig = await hmacHex(`${nonce}|${expiry}|${cleanUrl}`)
  return { token: `${nonce}.${expiry}.${sig}`, nonce }
}

export async function verifyLookupToken(
  token: string | undefined,
  cleanUrl: string
): Promise<{ valid: boolean; nonce: string | null }> {
  if (!token) return { valid: false, nonce: null }
  const parts = token.split('.')
  if (parts.length !== 3) return { valid: false, nonce: null }
  const [nonce, expiryStr, sig] = parts
  const expiry = Number(expiryStr)
  if (!Number.isFinite(expiry) || expiry < Date.now()) return { valid: false, nonce: null }
  const expected = await hmacHex(`${nonce}|${expiry}|${cleanUrl}`)
  if (sig.length !== expected.length) return { valid: false, nonce: null }
  let diff = 0
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0 ? { valid: true, nonce } : { valid: false, nonce: null }
}

// Returns the visitor id if the cookie's signature is valid, else null.
export async function verifyVisitorCookie(cookieValue: string | undefined): Promise<string | null> {
  if (!cookieValue) return null
  const dot = cookieValue.lastIndexOf('.')
  if (dot < 1) return null
  const id = cookieValue.slice(0, dot)
  const sig = cookieValue.slice(dot + 1)
  const expected = await hmacHex(id)
  if (sig.length !== expected.length) return null
  // constant-time-ish comparison
  let diff = 0
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0 ? id : null
}
