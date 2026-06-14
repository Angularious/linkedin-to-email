import { NextRequest, NextResponse } from 'next/server'
import { verifyVisitorCookie, signVisitorId, newVisitorId } from '@/lib/identity'

// Issue a signed visitor cookie on page load if one isn't already present and
// valid. By the time the browser POSTs to /api/lookup, it carries this cookie,
// so the rate limit can key on the individual rather than the shared IP. A
// scripted client that skips the page never gets a cookie and falls back to
// IP-based limiting in the route.
export async function middleware(request: NextRequest) {
  const res = NextResponse.next()

  const existing = request.cookies.get('lid')?.value
  const valid = await verifyVisitorCookie(existing)

  if (!valid) {
    const signed = await signVisitorId(newVisitorId())
    res.cookies.set('lid', signed, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // localhost is http in dev
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365, // 1 year
    })
  }

  return res
}

// Only run on the home page document — not API routes, static assets, or images.
export const config = {
  matcher: '/',
}
