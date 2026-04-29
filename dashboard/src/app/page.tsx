// CRITICAL: force-dynamic ensures every request queries Supabase live
// Without this, Next.js statically renders the page at build time and serves stale data
export const dynamic = 'force-dynamic'
export const revalidate = 0

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

function deriveChartPoints(trades: CopyTrade[], depositAmount: number, currentBotBalance?: number): ChartPoint[] {
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
  // Use real balance from bot-status.json if available (most accurate),
  // otherwise fall back to calculated balance from trade deltas
  const finalBalance = currentBotBalance ?? running
  if (Math.abs(finalBalance - running) > 1 || currentBotBalance !== undefined) {
    points.push({ time: now, balance: Math.max(0, finalBalance) })
  }

  return points
}

function readBotStatus(): { balance: number; winRate: number | null; updatedAt: string } | null {
  try {
    const raw = readFileSync(resolve(process.cwd(), '../.bot-status.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const age = Date.now() - new Date(parsed.updatedAt).getTime()
    if (age > 10 * 60 * 1000) return null // stale (>10 min)
    return parsed
  } catch { return null }
}

function deriveMetrics(trades: CopyTrade[], _performance: DailyPerformance[], depositAmount: number) {
  // Read the bot's authoritative balance from .bot-status.json (written every
  // 5 min by the runner). Falls back to the computed balance when the file is
  // missing or stale (>10 min).
  const botStatus = readBotStatus()
  const botBalance = botStatus?.balance

  const reservedCapital = trades
    .filter(t => t.status === 'open' || t.status === 'pending')
    .reduce((s, t) => s + (t.our_size ?? 0), 0)

  const decidedTrades = trades
    .filter(t => (t.status === 'closed' || t.status === 'stopped') && t.pnl != null && t.exit_time != null)
    .sort((a, b) => (a.exit_time ?? '').localeCompare(b.exit_time ?? ''))

  const realizedPnl = decidedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const computedBalance = depositAmount - reservedCapital + realizedPnl
  const balance = (botBalance && botBalance > 0) ? botBalance : computedBalance
  const totalReturnUsd = balance - depositAmount
  const totalReturnPct = ((balance - depositAmount) / depositAmount) * 100

  const wins = decidedTrades.filter(t => (t.pnl ?? 0) > 0).length
  const losses = decidedTrades.filter(t => (t.pnl ?? 0) < 0).length
  const decidedCount = wins + losses
  const winRate = decidedCount > 0 ? wins / decidedCount : null

  const avgReturn = decidedTrades.length > 0
    ? realizedPnl / decidedTrades.length
    : null

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
  const maxOpenPositionsConfig = (Number(process.env.MAX_OPEN_POSITIONS ?? '10') || 10) + (Number(process.env.MAX_SIGNAL_POSITIONS ?? '15') || 15)
  const riskPreset = process.env.RISK ?? 'paper'

  return {
    balance, totalReturnPct, totalReturnUsd, winRate, avgReturn, sharpe,
    maxDrawdown, openPositions, maxOpenPositionsConfig, riskPreset, paperMode,
    decidedCount, wins, losses,
    mirofishOverrideCount, mirofishOverrideLosses, mirofishOverrideWins,
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
    balance, totalReturnPct, totalReturnUsd, winRate, avgReturn, sharpe,
    maxDrawdown, openPositions, maxOpenPositionsConfig, riskPreset, paperMode,
    mirofishOverrideCount, mirofishOverrideLosses, mirofishOverrideWins,
  } = deriveMetrics(trades, performance, 6300)

  const chartPoints = deriveChartPoints(trades, 6300, readBotStatus()?.balance ?? undefined)

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
