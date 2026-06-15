import type { Metadata } from 'next'
import { Indie_Flower } from 'next/font/google'
import { Analytics } from '@vercel/analytics/react'
import { BotIdClient } from 'botid/client'
import './globals.css'

// Routes guarded by Vercel BotID. 'basic' is the free tier (deepAnalysis is Pro).
const protectedRoutes = [
  { path: '/api/lookup', method: 'POST', advancedOptions: { checkLevel: 'basic' as const } },
]

const indieFlower = Indie_Flower({
  weight: '400',
  subsets: ['latin'],
})

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://linkedin-to-email.vercel.app'
const title = 'LinkedIn → Email'
const description = 'Paste a LinkedIn profile URL. Get the work email. Free, no sign-up. Powered by Orthogonal.'

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title,
  description,
  openGraph: {
    title,
    description,
    url: siteUrl,
    siteName: 'LinkedIn → Email',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title,
    description,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <BotIdClient protect={protectedRoutes} />
      </head>
      <body style={{ fontFamily: indieFlower.style.fontFamily }}>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
