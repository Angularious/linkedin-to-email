// Hashes the rate-limit identity (a signed visitor id, or an IP as fallback)
// so we never store a raw IP or raw cookie value.
export async function hashIdentity(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
