'use client'
import { useState } from 'react'

const NAV_ITEMS = ['DASHBOARD', 'POSITIONS', 'STRATEGY', 'SIGNALS'] as const
type NavItem = typeof NAV_ITEMS[number]

interface NavBarProps {
  paperMode: boolean
  currentTime?: string
}

export function NavBar({ paperMode, currentTime }: NavBarProps) {
  const [active, setActive] = useState<NavItem>('DASHBOARD')

  return (
    <div style={{
      height: '36px',
      background: '#000',
      borderBottom: '1px solid #1a1a1a',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: '0',
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginRight: '24px', minWidth: '200px' }}>
        <span style={{ color: 'var(--green)', fontSize: '10px' }}>◆</span>
        <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', color: '#fff' }}>PATS-COPY</span>
        <span style={{ fontSize: '9px', color: '#444', letterSpacing: '0.05em' }}>v1.0.0</span>
      </div>

      {/* Nav items */}
      <div style={{ display: 'flex', flex: 1 }}>
        {NAV_ITEMS.map(item => (
          <button
            key={item}
            onClick={() => setActive(item)}
            style={{
              background: active === item ? '#1a1a1a' : 'transparent',
              border: 'none',
              borderTop: active === item ? '1px solid var(--green)' : '1px solid transparent',
              color: active === item ? '#fff' : '#444',
              fontFamily: 'var(--font-mono)',
              fontSize: '10px',
              letterSpacing: '0.12em',
              padding: '0 16px',
              height: '36px',
              cursor: 'pointer',
              transition: 'all 0.1s',
            }}
          >
            {item}
          </button>
        ))}
      </div>

      {/* Right: live indicator + time */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span className={paperMode ? '' : 'pulse'} style={{
          width: '6px', height: '6px', borderRadius: '50%',
          background: paperMode ? 'var(--yellow)' : 'var(--green)',
          display: 'inline-block',
        }} />
        <span style={{ fontSize: '10px', letterSpacing: '0.08em', color: '#888' }}>
          {paperMode ? 'PAPER MODE' : 'LIVE TRADING'}
        </span>
        <span style={{ fontSize: '10px', color: '#444', marginLeft: '8px', fontVariantNumeric: 'tabular-nums' }}>
          {currentTime ?? '--:--:--'}
        </span>
      </div>
    </div>
  )
}
