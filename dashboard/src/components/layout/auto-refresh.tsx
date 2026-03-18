'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

const REFRESH_INTERVAL_MS = 15_000

export function AutoRefresh() {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL_MS / 1000)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const countdownRef = useRef(REFRESH_INTERVAL_MS / 1000)

  useEffect(() => {
    // Set initial last updated time on mount
    setLastUpdated(new Date())

    const tick = setInterval(() => {
      countdownRef.current -= 1
      setCountdown(countdownRef.current)

      if (countdownRef.current <= 0) {
        countdownRef.current = REFRESH_INTERVAL_MS / 1000
        setCountdown(countdownRef.current)
        setLastUpdated(new Date())
        startTransition(() => router.refresh())
      }
    }, 1000)

    return () => clearInterval(tick)
  }, [router])

  const formatTime = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  return (
    <div style={{
      position: 'fixed',
      bottom: '26px',
      right: '0',
      zIndex: 50,
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      background: '#000',
      borderTop: '1px solid #1a1a1a',
      borderLeft: '1px solid #1a1a1a',
      padding: '4px 12px',
      fontFamily: 'var(--font-mono)',
    }}>
      {/* Pulsing dot */}
      <span style={{
        width: '5px',
        height: '5px',
        borderRadius: '50%',
        background: isPending ? 'var(--yellow)' : 'var(--green)',
        display: 'inline-block',
        boxShadow: isPending ? 'none' : '0 0 4px var(--green)',
        animation: isPending ? 'none' : 'livePulse 1.5s ease-in-out infinite',
      }} />

      {/* Status text */}
      <span style={{
        fontSize: '9px',
        letterSpacing: '0.12em',
        color: isPending ? 'var(--yellow)' : 'var(--green)',
        fontWeight: 700,
      }}>
        {isPending ? 'SYNCING' : 'LIVE'}
      </span>

      <span style={{ fontSize: '9px', color: '#222' }}>|</span>

      {/* Countdown */}
      {!isPending && (
        <span style={{ fontSize: '9px', color: '#444', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.06em' }}>
          SYNC IN {countdown}s
        </span>
      )}

      {/* Last updated */}
      {lastUpdated && !isPending && (
        <>
          <span style={{ fontSize: '9px', color: '#222' }}>|</span>
          <span style={{ fontSize: '9px', color: '#333', fontVariantNumeric: 'tabular-nums' }}>
            UPDATED {formatTime(lastUpdated)}
          </span>
        </>
      )}

      <style>{`
        @keyframes livePulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  )
}
