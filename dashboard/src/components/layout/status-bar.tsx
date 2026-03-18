interface StatusBarProps {
  paperMode: boolean
  openPositions: number
  glintUp: boolean
}

export function StatusBar({ paperMode, openPositions, glintUp }: StatusBarProps) {
  const metrics = [
    { label: 'LATENCY', value: '3ms' },
    { label: 'THROUGHPUT', value: '11.81 ops' },
    { label: 'EXECUTION', value: '-0.62s' },
    { label: 'SLIPPAGE', value: '0.06%' },
    { label: 'POSITIONS', value: String(openPositions) },
    { label: 'STATUS', value: paperMode ? 'PAPER' : 'STABLE', color: paperMode ? 'var(--yellow)' : 'var(--green)' },
  ]

  return (
    <div style={{
      height: '24px',
      background: '#000',
      borderTop: '1px solid #1a1a1a',
      display: 'flex',
      alignItems: 'center',
      padding: '0 12px',
      gap: '0',
    }}>
      {metrics.map((m, i) => (
        <div key={i} style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '0 16px',
          borderRight: i < metrics.length - 1 ? '1px solid #111' : 'none',
        }}>
          <span style={{ fontSize: '8px', letterSpacing: '0.12em', color: '#444' }}>{m.label}:</span>
          <span style={{ fontSize: '9px', color: m.color ?? '#888', fontVariantNumeric: 'tabular-nums' }}>{m.value}</span>
        </div>
      ))}
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{ fontSize: '8px', color: '#333', letterSpacing: '0.1em' }}>GLINT:</span>
        <span style={{ fontSize: '9px', color: glintUp ? 'var(--green)' : 'var(--red)' }}>
          {glintUp ? 'CONNECTED' : 'DOWN'}
        </span>
      </div>
    </div>
  )
}
