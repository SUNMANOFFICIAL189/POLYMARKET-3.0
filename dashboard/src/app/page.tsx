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

function deriveMetrics(trades: CopyTrade[], performance: DailyPerformance[], depositAmount: number) {
  const reservedCapital = trades
    .filter(t => t.status === 'open' || t.status === 'pending')
    .reduce((s, t) => s + (t.our_size ?? 0), 0)
  const realizedPnl = trades
    .filter(t => t.status === 'closed' || t.status === 'stopped')
    .reduce((s, t) => s + (t.pnl ?? 0), 0)
  const balance = depositAmount - reservedCapital + realizedPnl
  const totalReturnUsd = balance - depositAmount
  const totalReturnPct = ((balance - depositAmount) / depositAmount) * 100

  const totalWins = performance.reduce((s, d) => s + d.win_count, 0)
  const totalDecided = performance.reduce((s, d) => s + d.win_count + d.loss_count, 0)
  const winRate = totalDecided > 0 ? totalWins / totalDecided : null

  const openPositions = trades.filter(t => t.status === 'open').length
  const paperMode = process.env.PAPER_MODE !== 'false'

  return { balance, totalReturnPct, totalReturnUsd, winRate, openPositions, paperMode }
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

  const { balance, totalReturnPct, totalReturnUsd, winRate, openPositions, paperMode } =
    deriveMetrics(trades, performance, 6300)

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
          avgReturn={null}
          sharpe={null}
          roi={totalReturnPct}
          maxDrawdown={null}
          currentLeaderWallet={currentLeader?.wallet_address ?? null}
          currentLeaderScore={currentLeader?.composite_score ?? null}
          openPositions={openPositions}
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
