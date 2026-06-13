export async function hashIdentity(ip: string, fingerprint: string): Promise<string> {
  const raw = `${ip}:${fingerprint}`
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
