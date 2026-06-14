// Server-signed visitor identity.
//
// We issue each browser an HMAC-signed, httpOnly cookie (see middleware.ts)
// and key the rate limit on it. The client can't forge a valid cookie (no
// signing secret) and page JS can't read it (httpOnly), so distinct real
// people on a shared IP — students on campus WiFi, coworkers behind one NAT —
// each get their own quota instead of colliding on the IP.
//
// This is NOT the abuse defense (Turnstile + the global spend cap are). An
// abuser can still mint cookies by reloading the page, but each lookup still
// costs them a Turnstile solve and is bounded by the daily cap. The cookie's
// job is purely to stop legitimate users from blocking each other.

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
