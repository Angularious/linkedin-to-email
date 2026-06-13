import type { Metadata } from 'next'
import { Indie_Flower } from 'next/font/google'
import './globals.css'

const indieFlower = Indie_Flower({
  weight: '400',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'LinkedIn → Email',
  description: 'Paste a LinkedIn profile URL. Get the work email.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: indieFlower.style.fontFamily }}>{children}</body>
    </html>
  )
}
