'use client'

import type { Leader, CopyTrade, MirofishScan } from '@/lib/types'

interface RightPanelProps {
  leaders: Leader[]
  currentLeaderWallet: string | null
  recentTrades: CopyTrade[]
  mirofishScans: MirofishScan[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateWallet(addr: string): string {
  if (addr.length <= 10) return addr
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

function displayName(leader: Leader): string {
  if (leader.display_name) return leader.display_name
  return truncateWallet(leader.wallet_address)
}

function scoreCents(score: number): string {
  // composite_score is 0-100 scale; represent as Xc notation capped at 99
  const cents = Math.min(Math.round(score), 99)
  return `${cents}¢`
}

function pnlFormatted(pnl: number): string {
  const sign = pnl >= 0 ? '+' : ''
  return `${sign}${(pnl * 100).toFixed(1)}%`
}

function edgeCents(price: number): string {
  // price is 0-1; edge = distance from 0.5, expressed as cents
  const edge = Math.abs(price - 0.5) * 100
  return `+${edge.toFixed(1)}c`
}

function tradeId(id: string): string {
  return 'AGT-' + id.slice(-3).toUpperCase()
}

// ── Styles ───────────────────────────────────────────────────────────────────

const S = {
  container: {
    background: 'var(--bg)',
    width: '260px',
    height: '100%',
    overflowY: 'auto' as const,
    borderLeft: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column' as const,
    fontFamily: 'var(--font-mono)',
    flexShrink: 0,
  } as React.CSSProperties,

  sectionHeader: {
    fontSize: '9px',
    letterSpacing: '0.15em',
    textTransform: 'uppercase' as const,
    color: 'var(--text-muted)',
    padding: '8px 10px 6px',
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    borderBottom: '1px solid #0d0d0d',
  } as React.CSSProperties,

  diamond: {
    color: 'var(--green)',
    fontSize: '8px',
  } as React.CSSProperties,

  section1: {
    borderBottom: '1px solid var(--border)',
  } as React.CSSProperties,

  section2: {
    borderBottom: '1px solid var(--border)',
  } as React.CSSProperties,

  section3: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: 0,
  } as React.CSSProperties,

  section3Inner: {
    overflowY: 'auto' as const,
    flex: 1,
  } as React.CSSProperties,

  marketRow: (isActive: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    height: '20px',
    padding: '0 10px',
    fontSize: '10px',
    gap: '4px',
    color: isActive ? 'var(--green)' : '#888',
    cursor: 'default',
  }),

  marketName: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,

  score: {
    color: '#666',
    minWidth: '28px',
    textAlign: 'right' as const,
  } as React.CSSProperties,

  pnlPositive: {
    color: 'var(--green)',
    minWidth: '52px',
    textAlign: 'right' as const,
  } as React.CSSProperties,

  pnlNegative: {
    color: 'var(--red)',
    minWidth: '52px',
    textAlign: 'right' as const,
  } as React.CSSProperties,

  pnlNeutral: {
    color: '#555',
    minWidth: '52px',
    textAlign: 'right' as const,
  } as React.CSSProperties,

  eventCard: {
    padding: '6px 10px',
    cursor: 'default',
  } as React.CSSProperties,

  eventQuestion: {
    fontSize: '10px',
    color: '#e8e8e8',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as React.CSSProperties,

  eventEdge: {
    fontSize: '9px',
    color: 'var(--green)',
    marginTop: '1px',
  } as React.CSSProperties,

  scanRow: (alt: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    height: '16px',
    padding: '0 8px',
    fontSize: '9px',
    gap: '4px',
    background: alt ? '#050505' : '#000',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
  }),
} as const

// ── Component ────────────────────────────────────────────────────────────────

export function RightPanel({ leaders, currentLeaderWallet, recentTrades, mirofishScans }: RightPanelProps) {
  const top8 = leaders.slice(0, 8)

  const openTrades = recentTrades
    .filter((t) => t.status === 'open')
    .slice(0, 8)

  const scanFeed = recentTrades.slice(0, 60)

  return (
    <aside style={S.container}>

      {/* ── SECTION 1: POSITIONS / MARKETS ─────────────────────────────── */}
      <div style={S.section1}>
        <div style={S.sectionHeader}>
          <span style={S.diamond}>◆</span>
          <span>POSITIONS / MARKETS</span>
        </div>

        {top8.length === 0 ? (
          <div style={{ padding: '10px', fontSize: '9px', color: '#333', fontStyle: 'italic' }}>
            No leaders
          </div>
        ) : (
          top8.map((leader) => {
            const isActive = leader.wallet_address === currentLeaderWallet
            const pnl = leader.total_pnl_30d
            const pnlStyle =
              pnl > 0 ? S.pnlPositive :
              pnl < 0 ? S.pnlNegative :
              S.pnlNeutral
            return (
              <div key={leader.wallet_address} style={S.marketRow(isActive)}>
                <span style={S.marketName}>{displayName(leader)}</span>
                <span style={S.score}>{scoreCents(leader.composite_score)}</span>
                <span style={pnlStyle}>{pnlFormatted(leader.win_rate_30d)}</span>
              </div>
            )
          })
        )}
      </div>

      {/* ── SECTION 2: LIVE EVENTS ──────────────────────────────────────── */}
      <div style={S.section2}>
        <div style={S.sectionHeader}>
          <span style={S.diamond}>◆</span>
          <span>LIVE EVENTS</span>
        </div>

        {openTrades.length === 0 ? (
          <div style={{ padding: '10px', fontSize: '9px', color: '#333', fontStyle: 'italic' }}>
            No open positions
          </div>
        ) : (
          openTrades.map((trade) => (
            <div
              key={trade.id}
              style={S.eventCard}
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background = '#0a0a0a'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              <div style={S.eventQuestion}>
                {trade.market_question.slice(0, 22)}
              </div>
              <div style={S.eventEdge}>
                {edgeCents(trade.our_entry_price ?? trade.leader_entry_price)} edge
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── SECTION 3: SWARM INTELLIGENCE ──────────────────────────────── */}
      <div style={S.section3}>
        <div style={S.sectionHeader}>
          <span style={{ color: '#00ccff', fontSize: '8px' }}>◆</span>
          <span>SWARM INTELLIGENCE</span>
        </div>

        <div style={S.section3Inner}>
          {mirofishScans.length === 0 ? (
            <div style={{ padding: '10px', fontSize: '9px', color: '#333', fontStyle: 'italic' }}>
              Waiting for first scan...
            </div>
          ) : (
            mirofishScans.map((scan, i) => {
              const signalColor =
                scan.signal === 'YES' ? 'var(--green)' :
                scan.signal === 'NO' ? 'var(--red)' :
                '#666'

              const strengthLabel =
                scan.signal_strength === 'very_strong' ? '!!!' :
                scan.signal_strength === 'strong' ? '!!' :
                scan.signal_strength === 'moderate' ? '!' :
                ''

              const edgeColor = scan.edge_pct > 0 ? 'var(--green)' : scan.edge_pct < 0 ? 'var(--red)' : '#555'
              const edgeStr = `${scan.edge_pct > 0 ? '+' : ''}${scan.edge_pct.toFixed(1)}%`

              const confidenceColor =
                scan.confidence === 'high' ? 'var(--green)' :
                scan.confidence === 'medium' ? '#888' :
                '#444'

              return (
                <div key={scan.condition_id} style={{
                  padding: '6px 8px',
                  borderBottom: '1px solid #0a0a0a',
                  background: i % 2 === 1 ? '#030303' : '#000',
                }}>
                  <div style={{
                    fontSize: '9px',
                    color: '#ccc',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    marginBottom: '2px',
                  }}>
                    {scan.question.slice(0, 35)}
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '9px',
                  }}>
                    <span style={{ color: '#555' }}>
                      Mkt: {scan.market_price.toFixed(0)}%
                    </span>
                    <span style={{ color: '#00ccff' }}>
                      Swarm: {scan.swarm_probability.toFixed(0)}%
                    </span>
                    <span style={{ color: edgeColor, fontWeight: 'bold' }}>
                      {edgeStr}
                    </span>
                    <span style={{ color: signalColor, fontWeight: 'bold' }}>
                      {scan.signal}{strengthLabel}
                    </span>
                    <span style={{ color: confidenceColor, marginLeft: 'auto', fontSize: '8px' }}>
                      n={scan.sample_size}
                    </span>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

    </aside>
  )
}
