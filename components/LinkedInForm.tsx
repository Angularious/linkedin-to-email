'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Turnstile from 'react-turnstile'
import Image from 'next/image'

type UIState = 'idle' | 'loading' | 'success' | 'not_found' | 'rate_limited' | 'invalid_url'

interface SketchRef {
  canvas: HTMLCanvasElement | null
  el: HTMLElement | null
}

function useSketchBox(
  ref: React.RefObject<HTMLElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  opts: Record<string, unknown>,
  deps: unknown[]
) {
  const draw = useCallback(async () => {
    const el = ref.current
    const canvas = canvasRef.current
    if (!el || !canvas) return
    const rough = (await import('roughjs')).default
    const w = el.offsetWidth
    const h = el.offsetHeight
    if (!w || !h) return
    const pad = 16
    canvas.width = w + pad
    canvas.height = h + pad
    canvas.style.width = `${w + pad}px`
    canvas.style.height = `${h + pad}px`
    rough.canvas(canvas).rectangle(pad / 2, pad / 2, w, h, opts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    const t = setTimeout(draw, 80)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw])
}

export default function LinkedInForm() {
  const [url, setUrl] = useState('')
  const [uiState, setUiState] = useState<UIState>('idle')
  const [email, setEmail] = useState('')
  const [copied, setCopied] = useState(false)
  const [showModal, setShowModal] = useState(false)
  const [turnstileToken, setTurnstileToken] = useState('')
  const [fingerprint, setFingerprint] = useState('')

  // DOM refs for rough.js
  const cardRef = useRef<HTMLDivElement>(null)
  const cardCanvasRef = useRef<HTMLCanvasElement>(null)
  const inputRef = useRef<HTMLDivElement>(null)
  const inputCanvasRef = useRef<HTMLCanvasElement>(null)
  const btnRef = useRef<HTMLDivElement>(null)
  const btnCanvasRef = useRef<HTMLCanvasElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const resultCanvasRef = useRef<HTMLCanvasElement>(null)

  // Get browser fingerprint once on mount
  useEffect(() => {
    ;(async () => {
      try {
        const { getFingerprint } = await import('@thumbmarkjs/thumbmarkjs')
        const fp = await getFingerprint()
        setFingerprint(String(fp))
      } catch {
        // fingerprint is best-effort
      }
    })()
  }, [])

  // Draw all sketch borders
  const drawAll = useCallback(async () => {
    const rough = (await import('roughjs')).default

    const sketchBox = (
      canvas: HTMLCanvasElement | null,
      el: HTMLElement | null,
      options: Record<string, unknown>
    ) => {
      if (!canvas || !el) return
      const w = el.offsetWidth
      const h = el.offsetHeight
      if (!w || !h) return
      const pad = 16
      canvas.width = w + pad
      canvas.height = h + pad
      canvas.style.width = `${w + pad}px`
      canvas.style.height = `${h + pad}px`
      rough.canvas(canvas).rectangle(pad / 2, pad / 2, w, h, options)
    }

    // Card border
    sketchBox(cardCanvasRef.current, cardRef.current, {
      roughness: 2.8,
      strokeWidth: 2.5,
      stroke: '#111',
      bowing: 1.2,
    })

    // Input border
    sketchBox(inputCanvasRef.current, inputRef.current, {
      roughness: 1.8,
      strokeWidth: 1.6,
      stroke: '#888',
      bowing: 0.8,
    })

    // Button border
    sketchBox(btnCanvasRef.current, btnRef.current, {
      roughness: 2.5,
      strokeWidth: 3,
      stroke: '#111',
      bowing: 2,
    })

    // Result border (only when result is visible)
    if (
      resultRef.current &&
      resultCanvasRef.current &&
      ['success', 'not_found', 'rate_limited'].includes(uiState)
    ) {
      const stroke =
        uiState === 'success' ? '#3fb43a' : uiState === 'not_found' ? '#d81e1e' : '#888'
      sketchBox(resultCanvasRef.current, resultRef.current, {
        roughness: 2,
        strokeWidth: 2.2,
        stroke,
        bowing: 1.5,
      })
    }
  }, [uiState])

  useEffect(() => {
    const t = setTimeout(drawAll, 100)
    window.addEventListener('resize', drawAll)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', drawAll)
    }
  }, [drawAll])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!url.includes('linkedin.com/in/')) {
      setUiState('invalid_url')
      return
    }

    setUiState('loading')

    try {
      const res = await fetch('/api/lookup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-fingerprint': fingerprint,
        },
        body: JSON.stringify({ url: url.trim(), turnstileToken }),
      })

      const data = await res.json()

      if (data.email) {
        setEmail(data.email)
        setUiState('success')
      } else if (data.rate_limited) {
        setUiState('rate_limited')
      } else if (data.not_found) {
        setUiState('not_found')
        setShowModal(true)
      } else if (data.invalid) {
        setUiState('invalid_url')
      } else {
        setUiState('not_found')
        setShowModal(true)
      }
    } catch {
      setUiState('not_found')
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(email)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const isLoading = uiState === 'loading'
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY

  return (
    <>
      {/* Main card */}
      <div style={{ width: '100%', position: 'relative', transform: 'rotate(0.4deg)' }}>
        <div ref={cardRef} style={{ position: 'relative', padding: '36px 30px 28px', background: '#fff' }}>
          <canvas
            ref={cardCanvasRef}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
          />
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

              {/* Input */}
              <div ref={inputRef} style={{ position: 'relative', transform: 'rotate(-0.4deg)' }}>
                <canvas
                  ref={inputCanvasRef}
                  style={{ position: 'absolute', top: '-8px', left: '-8px', pointerEvents: 'none', zIndex: 2 }}
                />
                <input
                  type="text"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value)
                    if (uiState === 'invalid_url') setUiState('idle')
                  }}
                  placeholder="linkedin.com/in/someone..."
                  disabled={isLoading}
                  style={{
                    width: '100%',
                    padding: '13px 14px',
                    fontFamily: 'inherit',
                    fontSize: '20px',
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: '#111',
                    position: 'relative',
                    zIndex: 1,
                    opacity: isLoading ? 0.5 : 1,
                  }}
                />
              </div>

              {uiState === 'invalid_url' && (
                <p style={{ fontSize: '15px', color: '#d81e1e', marginTop: '-12px' }}>
                  please paste a valid linkedin.com/in/... URL
                </p>
              )}

              {/* Turnstile widget */}
              {siteKey && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <Turnstile
                    sitekey={siteKey}
                    onVerify={(token) => setTurnstileToken(token)}
                  />
                </div>
              )}

              {/* Button */}
              <div ref={btnRef} style={{ position: 'relative', transform: 'rotate(0.7deg)', cursor: isLoading ? 'default' : 'pointer' }}>
                <canvas
                  ref={btnCanvasRef}
                  style={{ position: 'absolute', top: '-8px', left: '-8px', pointerEvents: 'none', zIndex: 2 }}
                />
                <button
                  type="submit"
                  disabled={isLoading}
                  style={{
                    width: '100%',
                    padding: '13px 14px',
                    fontFamily: 'inherit',
                    fontSize: '22px',
                    fontWeight: 400,
                    border: 'none',
                    background: 'transparent',
                    color: '#111',
                    cursor: isLoading ? 'default' : 'pointer',
                    position: 'relative',
                    zIndex: 1,
                    letterSpacing: '1px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '10px',
                  }}
                >
                  {isLoading ? (
                    <>
                      <Spinner />
                      looking...
                    </>
                  ) : (
                    'find their email →'
                  )}
                </button>
              </div>
            </form>

            <p style={{ fontSize: '16px', color: '#aaa', textAlign: 'center' }}>
              3 free lookups per day &nbsp;·&nbsp; no sign-up needed
            </p>
          </div>
        </div>
      </div>

      {/* Result box */}
      {(uiState === 'success' || uiState === 'not_found' || uiState === 'rate_limited') && (
        <div
          style={{
            width: '100%',
            transform:
              uiState === 'success'
                ? 'rotate(-0.3deg)'
                : uiState === 'not_found'
                ? 'rotate(0.5deg)'
                : 'rotate(-0.2deg)',
          }}
        >
          <div ref={resultRef} style={{ position: 'relative' }}>
            <canvas
              ref={resultCanvasRef}
              style={{ position: 'absolute', top: '-8px', left: '-8px', pointerEvents: 'none', zIndex: 2 }}
            />
            <div
              style={{
                padding: '14px 16px',
                fontSize: '20px',
                color: '#111',
                lineHeight: 1.5,
                position: 'relative',
                zIndex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
              }}
            >
              {uiState === 'success' && (
                <>
                  <Image src="/check.svg" width={32} height={24} alt="found" style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{email}</span>
                  <button
                    onClick={handleCopy}
                    style={{
                      fontFamily: 'inherit',
                      fontSize: '16px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#555',
                      textDecoration: 'underline',
                      textDecorationStyle: 'wavy',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    {copied ? 'copied!' : 'copy'}
                  </button>
                </>
              )}

              {uiState === 'not_found' && (
                <>
                  <Image src="/x.svg" width={28} height={28} alt="not found" style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>
                    this one is hard to find.{' '}
                    <a
                      href="https://orthogonal.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: '#c0392b',
                        textDecoration: 'underline',
                        textDecorationStyle: 'wavy',
                        textUnderlineOffset: '3px',
                      }}
                    >
                      sign up at orthogonal.com
                    </a>{' '}
                    to unlock more.
                  </span>
                </>
              )}

              {uiState === 'rate_limited' && (
                <>
                  <Image src="/smiley.svg" width={40} height={32} alt="rate limited" style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>
                    3/3 searches used today. back tomorrow — or{' '}
                    <a
                      href="https://orthogonal.com"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: '#c0392b',
                        textDecoration: 'underline',
                        textDecorationStyle: 'wavy',
                        textUnderlineOffset: '3px',
                      }}
                    >
                      sign up for unlimited.
                    </a>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Not-found modal */}
      {showModal && (
        <div
          onClick={() => setShowModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: '20px',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              maxWidth: '400px',
              width: '100%',
              padding: '36px 32px',
              transform: 'rotate(-0.5deg)',
              position: 'relative',
            }}
          >
            <ModalBorder />
            <div style={{ position: 'relative', zIndex: 1 }}>
              <p
                style={{
                  fontSize: '22px',
                  color: '#111',
                  lineHeight: 1.4,
                  marginBottom: '24px',
                }}
              >
                this contact is hard to find.
                <br />
                sign up at orthogonal.com to unlock more searches.
              </p>
              <a
                href="https://orthogonal.com"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '13px 14px',
                  fontFamily: 'inherit',
                  fontSize: '20px',
                  textAlign: 'center',
                  color: '#111',
                  textDecoration: 'none',
                  letterSpacing: '1px',
                  position: 'relative',
                  border: '2px solid #111',
                }}
              >
                go to orthogonal.com →
              </a>
              <button
                onClick={() => setShowModal(false)}
                style={{
                  marginTop: '16px',
                  width: '100%',
                  fontFamily: 'inherit',
                  fontSize: '17px',
                  color: '#aaa',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textDecorationStyle: 'wavy',
                }}
              >
                maybe later
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function Spinner() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <circle cx="10" cy="10" r="8" fill="none" stroke="#ccc" strokeWidth="2.5" />
      <path d="M10 2 a8 8 0 0 1 8 8" fill="none" stroke="#111" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function ModalBorder() {
  const ref = useRef<HTMLCanvasElement>(null)
  const parentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ;(async () => {
      const canvas = ref.current
      const parent = canvas?.parentElement as HTMLDivElement | null
      if (!canvas || !parent) return
      const rough = (await import('roughjs')).default
      const w = parent.offsetWidth
      const h = parent.offsetHeight
      canvas.width = w
      canvas.height = h
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      rough.canvas(canvas).rectangle(5, 5, w - 10, h - 10, {
        roughness: 2.8,
        strokeWidth: 2.5,
        stroke: '#111',
        bowing: 1.2,
      })
    })()
  }, [])

  return (
    <canvas
      ref={ref}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
    />
  )
}
