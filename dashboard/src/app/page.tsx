// CRITICAL: force-dynamic ensures every request queries Supabase live
// Without this, Next.js statically renders the page at build time and serves stale data
export const dynamic = 'force-dynamic'
export const revalidate = 0

import { getLeaders, getCurrentLeader, getCopyTrades, getDailyPerformance, getLeaderHistory, getMirofishScans } from '@/lib/queries'
import { TickerBar } from '@/components/layout/ticker-bar'
import { NavBar } from '@/components/layout/nav-bar'
import { Clock } from '@/components/layout/clock'
import { StatusBar } from '@/components/layout/status-bar'
import LeftPanel from '@/components/panels/left-panel'
import { CenterPanel } from '@/components/panels/center-panel'
import { RightPanel } from '@/components/panels/right-panel'
import { NeuralGlobe } from '@/components/globe'
import type { Leader, CopyTrade, DailyPerformance, LeaderHistory, ChartPoint, MirofishScan } from '@/lib/types'

function deriveChartPoints(trades: CopyTrade[], depositAmount: number): ChartPoint[] {
  // Chart shows PORTFOLIO VALUE over time.
  // Realized P&L events move the line historically.
  // Final point = actual current balance (deposit - reserved + realized).
  const events: { time: string; delta: number }[] = []

  for (const t of trades) {
    if (t.status === 'vetoed' || t.status === 'skipped') continue
    if ((t.status === 'closed' || t.status === 'stopped') && t.exit_time) {
      events.push({ time: t.exit_time, delta: t.pnl ?? 0 })
    }
  }

  events.sort((a, b) => a.time.localeCompare(b.time))

  const points: ChartPoint[] = [{ time: 'START', balance: depositAmount }]
  let running = depositAmount
  for (const e of events) {
    running += e.delta
    const label = new Date(e.time).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    points.push({ time: label, balance: Math.max(0, running) })
  }

  // Add current actual balance as final point (includes unrealized from open positions)
  const reservedCapital = trades
    .filter(t => t.status === 'open' || t.status === 'pending')
    .reduce((s, t) => s + (t.our_size ?? 0), 0)
  const actualBalance = depositAmount - reservedCapital + (running - depositAmount)
  const now = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  // Only add if actual balance differs from last realized point (open positions exist)
  if (Math.abs(actualBalance - running) > 1) {
    points.push({ time: now, balance: Math.max(0, actualBalance) })
  }

  return points
}

function deriveMetrics(trades: CopyTrade[], _performance: DailyPerformance[], depositAmount: number) {
  // Balance: deposit − capital reserved in open positions + realized PnL on closed trades.
  const reservedCapital = trades
    .filter(t => t.status === 'open' || t.status === 'pending')
    .reduce((s, t) => s + (t.our_size ?? 0), 0)

  // Decided trades = closed + stopped with a non-null PnL. These are the only ones that
  // contribute to WR / avg return / drawdown / Sharpe. Sorted chronologically by exit time
  // so drawdown walks balance correctly.
  const decidedTrades = trades
    .filter(t => (t.status === 'closed' || t.status === 'stopped') && t.pnl != null && t.exit_time != null)
    .sort((a, b) => (a.exit_time ?? '').localeCompare(b.exit_time ?? ''))

  const realizedPnl = decidedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const balance = depositAmount - reservedCapital + realizedPnl
  const totalReturnUsd = balance - depositAmount
  const totalReturnPct = ((balance - depositAmount) / depositAmount) * 100

  // Win rate: wins / (wins + losses). Zero-PnL trades (rare) neither win nor lose.
  const wins = decidedTrades.filter(t => (t.pnl ?? 0) > 0).length
  const losses = decidedTrades.filter(t => (t.pnl ?? 0) < 0).length
  const decidedCount = wins + losses
  const winRate = decidedCount > 0 ? wins / decidedCount : null

  // Average return per decided trade (USD).
  const avgReturn = decidedTrades.length > 0
    ? realizedPnl / decidedTrades.length
    : null

  // Max drawdown: walk running balance, track peak, record max (peak − running) / peak.
  // Returned as a percentage.
  let runningBalance = depositAmount
  let peakBalance = depositAmount
  let maxDrawdownPct = 0
  for (const t of decidedTrades) {
    runningBalance += t.pnl ?? 0
    if (runningBalance > peakBalance) peakBalance = runningBalance
    const dd = peakBalance > 0 ? (peakBalance - runningBalance) / peakBalance : 0
    if (dd > maxDrawdownPct) maxDrawdownPct = dd
  }
  const maxDrawdown = decidedTrades.length > 0 ? maxDrawdownPct * 100 : null

  // Simple (non-annualized) Sharpe: mean(per-trade return %) / stdev(per-trade return %).
  // Per-trade return % = pnl / our_size. Requires ≥2 trades and non-zero stdev.
  const perTradeReturns = decidedTrades
    .filter(t => (t.our_size ?? 0) > 0)
    .map(t => (t.pnl ?? 0) / (t.our_size ?? 1))
  let sharpe: number | null = null
  if (perTradeReturns.length >= 2) {
    const mean = perTradeReturns.reduce((s, r) => s + r, 0) / perTradeReturns.length
    const variance = perTradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (perTradeReturns.length - 1)
    const stdev = Math.sqrt(variance)
    if (stdev > 0) sharpe = mean / stdev
  }

  // MiroFish override count: trades where the confirmation reasoning logs
  // "MiroFish contradicts" but the decision was to proceed anyway. Breakdown by outcome
  // so you can see how often the override is costly.
  const mirofishOverrides = trades.filter(t =>
    (t.confirmation_reason ?? '').includes('MiroFish contradicts') &&
    (t.confirmation_reason ?? '').includes('proceeding with leader')
  )
  const mirofishOverrideCount = mirofishOverrides.length
  const mirofishOverrideLosses = mirofishOverrides
    .filter(t => (t.status === 'closed' || t.status === 'stopped') && (t.pnl ?? 0) < 0).length
  const mirofishOverrideWins = mirofishOverrides
    .filter(t => (t.status === 'closed' || t.status === 'stopped') && (t.pnl ?? 0) > 0).length

  const openPositions = trades.filter(t => t.status === 'open').length
  const paperMode = process.env.PAPER_MODE !== 'false'

  // Expose the configured max open positions so the UI can render a real utilisation ratio
  // instead of the previous tautological (open / max(open, 1)) formula. Falls back to a
  // sensible default when the env var isn't set.
  const maxOpenPositionsConfig = Number(process.env.MAX_OPEN_POSITIONS ?? '5') || 5
  const riskPreset = process.env.RISK ?? 'moderate'

  return {
    balance,
    totalReturnPct,
    totalReturnUsd,
    winRate,
    avgReturn,
    sharpe,
    maxDrawdown,
    openPositions,
    maxOpenPositionsConfig,
    riskPreset,
    paperMode,
    decidedCount,
    wins,
    losses,
    mirofishOverrideCount,
    mirofishOverrideLosses,
    mirofishOverrideWins,
  }
}

export default async function DashboardPage() {
  let leaders: Leader[] = []
  let currentLeader: Leader | null = null
  let trades: CopyTrade[] = []
  let performance: DailyPerformance[] = []
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let leaderHistory: LeaderHistory[] = []
  let mirofishScans: MirofishScan[] = []

  try {
    ;[leaders, currentLeader, trades, performance, leaderHistory, mirofishScans] = await Promise.all([
      getLeaders(),
      getCurrentLeader(),
      getCopyTrades(2000),
      getDailyPerformance(30),
      getLeaderHistory(),
      getMirofishScans(),
    ])
  } catch {
    // Supabase unavailable — render with empty states
  }

  const {
    balance,
    totalReturnPct,
    totalReturnUsd,
    winRate,
    avgReturn,
    sharpe,
    maxDrawdown,
    openPositions,
    maxOpenPositionsConfig,
    riskPreset,
    paperMode,
    mirofishOverrideCount,
    mirofishOverrideLosses,
    mirofishOverrideWins,
  } = deriveMetrics(trades, performance, 6300)

  const chartPoints = deriveChartPoints(trades, 6300)

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: '#000',
      overflow: 'hidden',
      fontFamily: 'var(--font-mono)',
    }}>

      {/* ── Top ticker ── */}
      <TickerBar />

      {/* ── Nav bar + clock ── */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #111', flexShrink: 0 }}>
        <div style={{ flex: 1 }}>
          <NavBar paperMode={paperMode} />
        </div>
        <div style={{ paddingRight: '14px', flexShrink: 0 }}>
          <Clock />
        </div>
      </div>

      {/* ── Second ticker ── */}
      <TickerBar />

      {/* ── Main 3-panel content ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* Left panel — stats, balance, leader */}
        <LeftPanel
          balance={balance}
          depositAmount={6300}
          totalReturnPct={totalReturnPct}
          totalReturnUsd={totalReturnUsd}
          winRate={winRate !== null ? winRate * 100 : null}
          trades={trades.length}
          avgReturn={avgReturn}
          sharpe={sharpe}
          roi={totalReturnPct}
          maxDrawdown={maxDrawdown}
          currentLeaderWallet={currentLeader?.wallet_address ?? null}
          currentLeaderScore={currentLeader?.composite_score ?? null}
          openPositions={openPositions}
          maxOpenPositionsConfig={maxOpenPositionsConfig}
          riskPreset={riskPreset}
          mirofishOverrideCount={mirofishOverrideCount}
          mirofishOverrideLosses={mirofishOverrideLosses}
          mirofishOverrideWins={mirofishOverrideWins}
          paperMode={paperMode}
        />

        {/* Center — chart + activity feed + globe */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <CenterPanel
            performanceData={performance}
            chartPoints={chartPoints}
            recentTrades={trades}
            currentBalance={balance}
          />

          {/* Neural globe */}
          <div style={{
            height: '280px',
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            borderTop: '1px solid #111',
            background: '#000',
            position: 'relative',
          }}>
            <div style={{
              position: 'absolute',
              top: '8px',
              left: '12px',
              fontSize: '9px',
              letterSpacing: '0.15em',
              color: '#333',
              textTransform: 'uppercase',
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
            }}>
              <span style={{ color: 'var(--green)' }}>◆</span>
              NEURAL TOPOLOGY
            </div>
            <NeuralGlobe />
          </div>
        </div>

        {/* Right panel — positions, events, scanner */}
        <RightPanel
          leaders={leaders}
          currentLeaderWallet={currentLeader?.wallet_address ?? null}
          recentTrades={trades}
          mirofishScans={mirofishScans}
        />

      </div>

      {/* ── Bottom status bar ── */}
      <StatusBar
        paperMode={paperMode}
        openPositions={openPositions}
        glintUp={true}
      />

    </div>
  )
}
