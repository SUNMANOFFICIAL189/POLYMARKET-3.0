'use client'

interface TickerItem {
  label: string
  value: string
  change: number
}

const MOCK_TICKERS: TickerItem[] = [
  { label: 'BTC >$72k', value: '51¢', change: 6.1 },
  { label: 'ETH >$5k', value: '24¢', change: -2.3 },
  { label: 'Fed Rate Cut', value: '65¢', change: -0.8 },
  { label: 'Trump Win', value: '54¢', change: 1.2 },
  { label: 'Arsenal Win', value: '34¢', change: 3.1 },
  { label: 'Bitcoin Halving', value: '88¢', change: 0.4 },
  { label: 'BTC >$67k', value: '72¢', change: 1.9 },
  { label: 'Lakers ML', value: '58¢', change: 1.4 },
  { label: 'Chiefs SB', value: '56¢', change: -15.2 },
  { label: 'SOL >$200', value: '44¢', change: 2.1 },
]

export function TickerBar() {
  const doubled = [...MOCK_TICKERS, ...MOCK_TICKERS]

  return (
    <div style={{
      height: '22px',
      background: '#000',
      borderBottom: '1px solid #1a1a1a',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
    }}>
      <div className="ticker-track" style={{ gap: '0' }}>
        {doubled.map((item, i) => (
          <span key={i} style={{
            padding: '0 16px',
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            borderRight: '1px solid #111',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
          }}>
            <span style={{ color: '#888' }}>{item.label}</span>
            <span style={{ color: '#e8e8e8' }}>{item.value}</span>
            <span style={{ color: item.change >= 0 ? 'var(--green)' : 'var(--red)', fontSize: '9px' }}>
              {item.change >= 0 ? '+' : ''}{item.change}%
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
