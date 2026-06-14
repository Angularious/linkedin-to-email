// Rate-limit identity is derived from IP only. The browser fingerprint we
// used to mix in here was client-supplied (an x-fingerprint header), so an
// abuser could vary it per request to mint unlimited identities. IP comes
// from the edge (x-forwarded-for) and can't be forged by the client, so it's
// the trustworthy anchor. We still hash it so we never store a raw IP.
export async function hashIp(ip: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
