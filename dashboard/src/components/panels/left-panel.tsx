'use client'

interface LeftPanelProps {
  balance: number
  depositAmount: number
  totalReturnPct: number
  totalReturnUsd: number
  winRate: number | null
  trades: number
  avgReturn: number | null
  sharpe: number | null
  roi: number | null
  maxDrawdown: number | null
  currentLeaderWallet: string | null
  currentLeaderScore: number | null
  openPositions: number
  maxOpenPositionsConfig: number
  riskPreset: string
  mirofishOverrideCount: number
  mirofishOverrideLosses: number
  mirofishOverrideWins: number
  paperMode: boolean
}

// ── Format helpers ──────────────────────────────────────────────────────────

function formatUSD(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPct(n: number): string {
  return n.toFixed(1) + '%'
}

function truncateWallet(addr: string): string {
  if (addr.length <= 10) return addr
  return addr.slice(0, 6) + '...' + addr.slice(-4)
}

// ── Styles ───────────────────────────────────────────────────────────────────

const S = {
  container: {
    background: 'var(--bg)',
    width: '240px',
    height: '100%',
    overflowY: 'auto' as const,
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column' as const,
    fontFamily: 'var(--font-mono)',
  },
  section: {
    borderBottom: '1px solid var(--border)',
    padding: '12px',
  },
  label: {
    fontSize: '9px',
    letterSpacing: '0.15em',
    textTransform: 'uppercase' as const,
    color: 'var(--text-muted)',
    lineHeight: 1.2,
  },
  balanceValue: {
    fontSize: '28px',
    fontWeight: 700,
    color: '#fff',
    fontFamily: 'var(--font-mono)',
    letterSpacing: '-0.02em',
    lineHeight: 1.1,
    marginTop: '2px',
  },
  depositLine: {
    fontSize: '10px',
    color: 'var(--text-muted)',
    marginTop: '4px',
  },
  sparklinePlaceholder: {
    height: '50px',
    background: '#050505',
    border: '1px solid #111',
    borderRadius: '2px',
    margin: '8px 0 0 0',
  },
  returnRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '6px',
  },
  statsGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px 8px',
  },
  statCell: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  statValue: (color: string): React.CSSProperties => ({
    fontSize: '16px',
    fontWeight: 700,
    color,
    fontFamily: 'var(--font-mono)',
    lineHeight: 1.2,
  }),
  kvRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '6px',
  },
  kvKey: {
    fontSize: '9px',
    letterSpacing: '0.15em',
    textTransform: 'uppercase' as const,
    color: 'var(--text-muted)',
  },
  kvValue: {
    fontSize: '11px',
    color: '#fff',
    fontFamily: 'var(--font-mono)',
    fontWeight: 600,
    textAlign: 'right' as const,
  },
  leaderHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginBottom: '8px',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--green)',
    flexShrink: 0,
  },
  leaderLabel: {
    fontSize: '9px',
    letterSpacing: '0.15em',
    textTransform: 'uppercase' as const,
    color: 'var(--green)',
    fontWeight: 700,
  },
  leaderWallet: {
    fontSize: '12px',
    color: 'var(--green)',
    fontFamily: 'var(--font-mono)',
    letterSpacing: '0.05em',
    marginBottom: '4px',
    wordBreak: 'break-all' as const,
  },
  leaderScore: {
    fontSize: '11px',
    color: '#fff',
    fontFamily: 'var(--font-mono)',
  },
  noLeader: {
    fontSize: '10px',
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },
} as const

// ── Component ────────────────────────────────────────────────────────────────

export default function LeftPanel({
  balance,
  depositAmount,
  totalReturnPct,
  totalReturnUsd,
  winRate,
  trades,
  avgReturn,
  sharpe,
  roi,
  maxDrawdown,
  currentLeaderWallet,
  currentLeaderScore,
  openPositions,
  maxOpenPositionsConfig,
  riskPreset,
  mirofishOverrideCount,
  mirofishOverrideLosses,
  mirofishOverrideWins,
  paperMode,
}: LeftPanelProps) {
  const returnPositive = totalReturnUsd >= 0
  const returnColor = returnPositive ? 'var(--green)' : 'var(--red)'
  const returnSign = returnPositive ? '+' : ''

  const winRateColor =
    winRate !== null && winRate > 60 ? 'var(--green)' : '#fff'

  return (
    <aside style={S.container}>
      {/* ── Balance Section ── */}
      <div style={S.section}>
        <div style={S.label}>Portfolio Balance</div>
        <div style={S.balanceValue}>{formatUSD(balance)}</div>
        <div style={S.depositLine}>from {formatUSD(depositAmount)} deposit</div>

        {/* Total return pill */}
        <div style={S.returnRow}>
          <span
            style={{
              fontSize: '11px',
              fontWeight: 700,
              color: returnColor,
              fontFamily: 'var(--font-mono)',
            }}
          >
            {returnSign}{formatUSD(totalReturnUsd)}
          </span>
          <span
            style={{
              fontSize: '10px',
              color: returnColor,
              fontFamily: 'var(--font-mono)',
            }}
          >
            ({returnSign}{formatPct(totalReturnPct)})
          </span>
        </div>

        {/* Sparkline placeholder */}
        <div style={S.sparklinePlaceholder} />
      </div>

      {/* ── Performance Stats Grid ── */}
      <div style={S.section}>
        <div style={{ ...S.statsGrid }}>
          {/* WIN RATE */}
          <div style={S.statCell}>
            <span style={S.label}>Win Rate</span>
            <span style={S.statValue(winRateColor)}>
              {winRate !== null ? formatPct(winRate) : '—'}
            </span>
          </div>

          {/* TRADES */}
          <div style={S.statCell}>
            <span style={S.label}>Trades</span>
            <span style={S.statValue('#fff')}>
              {trades.toLocaleString()}
            </span>
          </div>

          {/* AVG RETURN */}
          <div style={S.statCell}>
            <span style={S.label}>Avg Return</span>
            <span style={S.statValue('#fff')}>
              {avgReturn !== null ? formatUSD(avgReturn) : '—'}
            </span>
          </div>

          {/* SHARPE */}
          <div style={S.statCell}>
            <span style={S.label}>Sharpe</span>
            <span style={S.statValue('#fff')}>
              {sharpe !== null ? sharpe.toFixed(1) : '—'}
            </span>
          </div>

          {/* ROI */}
          <div style={S.statCell}>
            <span style={S.label}>ROI</span>
            <span style={S.statValue('#fff')}>
              {roi !== null ? formatPct(roi) : '—'}
            </span>
          </div>

          {/* MAX DRAWDOWN */}
          <div style={S.statCell}>
            <span style={S.label}>Max DD</span>
            <span style={S.statValue('var(--red)')}>
              {maxDrawdown !== null ? formatPct(maxDrawdown) : '—'}
            </span>
          </div>
        </div>

        {mirofishOverrideCount > 0 && (
          <div style={{
            marginTop: '12px',
            padding: '8px',
            border: '1px solid var(--border)',
            borderRadius: '2px',
            background: '#0a0500',
          }}>
            <div style={S.label}>MiroFish Overrides</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '2px' }}>
              <span style={S.statValue('var(--yellow)')}>
                {mirofishOverrideCount}
              </span>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {mirofishOverrideWins}W · {mirofishOverrideLosses}L
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ── Strategy / Mode Info ── */}
      <div style={S.section}>
        <div style={{ marginBottom: '8px' }}>
          <span style={S.label}>System Info</span>
        </div>

        <div style={S.kvRow}>
          <span style={S.kvKey}>Strategy</span>
          <span style={S.kvValue}>Copy Trade</span>
        </div>

        <div style={S.kvRow}>
          <span style={S.kvKey}>Mode</span>
          <span
            style={{
              ...S.kvValue,
              color: paperMode ? 'var(--yellow)' : 'var(--green)',
            }}
          >
            {paperMode ? 'PAPER' : 'LIVE'}
          </span>
        </div>

        <div style={S.kvRow}>
          <span style={S.kvKey}>Risk</span>
          <span style={S.kvValue}>
            {riskPreset.charAt(0).toUpperCase() + riskPreset.slice(1)}
          </span>
        </div>

        <div style={{ ...S.kvRow, marginBottom: 0 }}>
          <span style={S.kvKey}>Slots</span>
          <span
            style={{
              ...S.kvValue,
              color: openPositions >= maxOpenPositionsConfig ? 'var(--red)' : '#fff',
            }}
          >
            {openPositions} / {maxOpenPositionsConfig}
          </span>
        </div>

        <div style={{ ...S.kvRow, marginTop: '6px', marginBottom: 0 }}>
          <span style={S.kvKey}>Slot Util</span>
          <span
            style={{
              ...S.kvValue,
              color: openPositions >= maxOpenPositionsConfig ? 'var(--red)' : '#fff',
            }}
          >
            {maxOpenPositionsConfig > 0
              ? formatPct((openPositions / maxOpenPositionsConfig) * 100)
              : '—'}
          </span>
        </div>
      </div>

      {/* ── Current Leader ── */}
      <div style={{ ...S.section, borderBottom: 'none', flexGrow: 1 }}>
        <div style={S.leaderHeader}>
          <div style={S.dot} />
          <span style={S.leaderLabel}>Current Leader</span>
        </div>

        {currentLeaderWallet ? (
          <>
            <a
              href={`https://polymarket.com/profile/${currentLeaderWallet}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{...S.leaderWallet, textDecoration: 'none', cursor: 'pointer'}}
              onMouseEnter={(e) => { (e.target as HTMLElement).style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { (e.target as HTMLElement).style.textDecoration = 'none'; }}
            >
              {truncateWallet(currentLeaderWallet)}
            </a>
            <div style={S.leaderScore}>
              Score:{' '}
              <span style={{ color: 'var(--green)', fontWeight: 700 }}>
                {currentLeaderScore !== null
                  ? currentLeaderScore.toFixed(2)
                  : '—'}
              </span>
            </div>
          </>
        ) : (
          <div style={S.noLeader}>No leader selected</div>
        )}
      </div>
    </aside>
  )
}
