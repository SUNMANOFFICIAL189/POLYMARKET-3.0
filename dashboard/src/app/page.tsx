import { getLeaders, getCurrentLeader, getCopyTrades, getDailyPerformance, getLeaderHistory } from '@/lib/queries'
import { TickerBar } from '@/components/layout/ticker-bar'
import { NavBar } from '@/components/layout/nav-bar'
import { Clock } from '@/components/layout/clock'
import { StatusBar } from '@/components/layout/status-bar'
import LeftPanel from '@/components/panels/left-panel'
import { CenterPanel } from '@/components/panels/center-panel'
import { RightPanel } from '@/components/panels/right-panel'
import { NeuralGlobe } from '@/components/globe'
import type { Leader, CopyTrade, DailyPerformance, LeaderHistory } from '@/lib/types'

function deriveMetrics(trades: CopyTrade[], performance: DailyPerformance[]) {
  const latest = performance[performance.length - 1]
  const first = performance[0]
  const balance = latest?.balance_usdc ?? 6300
  const totalReturnPct = first?.balance_usdc
    ? ((balance - first.balance_usdc) / first.balance_usdc) * 100
    : 0
  const totalReturnUsd = balance - (first?.balance_usdc ?? balance)

  const totalWins = performance.reduce((s, d) => s + d.win_count, 0)
  const totalDecided = performance.reduce((s, d) => s + d.win_count + d.loss_count, 0)
  const winRate = totalDecided > 0 ? totalWins / totalDecided : null

  const openPositions = trades.filter(t => t.status === 'open').length
  const paperMode = trades.length === 0 ? true : trades.some(t => t.paper_mode)

  return { balance, totalReturnPct, totalReturnUsd, winRate, openPositions, paperMode }
}

export default async function DashboardPage() {
  let leaders: Leader[] = []
  let currentLeader: Leader | null = null
  let trades: CopyTrade[] = []
  let performance: DailyPerformance[] = []
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let leaderHistory: LeaderHistory[] = []

  try {
    ;[leaders, currentLeader, trades, performance, leaderHistory] = await Promise.all([
      getLeaders(),
      getCurrentLeader(),
      getCopyTrades(200),
      getDailyPerformance(30),
      getLeaderHistory(),
    ])
  } catch {
    // Supabase unavailable — render with empty states
  }

  const { balance, totalReturnPct, totalReturnUsd, winRate, openPositions, paperMode } =
    deriveMetrics(trades, performance)

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
