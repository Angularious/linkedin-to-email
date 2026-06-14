import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'LinkedIn → Email — paste a profile, get the email'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

// Branded social preview card, generated at the edge. Mirrors the site's
// minimal black-on-white look so shares on Twitter/LinkedIn feel on-brand.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', fontSize: 110, fontWeight: 700, color: '#111' }}>
          LinkedIn → Email
        </div>
        <div style={{ display: 'flex', fontSize: 42, color: '#555', marginTop: 24 }}>
          paste a profile. get the email.
        </div>
        <div style={{ display: 'flex', fontSize: 30, color: '#aaa', marginTop: 90 }}>
          powered by orthogonal.com
        </div>
      </div>
    ),
    { ...size }
  )
}
