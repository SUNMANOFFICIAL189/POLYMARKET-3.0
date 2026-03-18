'use client'

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { LeaderboardTable } from '@/components/leaderboard/leaderboard-table'
import { TradeHistoryTable } from '@/components/trades/trade-history-table'
import type { Leader, LeaderHistory, CopyTrade } from '@/lib/types'

interface DashboardTabsProps {
  leaders: Leader[]
  currentLeaderWallet: string | null
  trades: CopyTrade[]
  leaderHistory: LeaderHistory[]
}

function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function DashboardTabs({ leaders, currentLeaderWallet, trades, leaderHistory }: DashboardTabsProps) {
  return (
    <Tabs defaultValue="leaderboard" className="w-full">
      <TabsList className="bg-slate-900 border border-slate-800 h-9">
        <TabsTrigger value="leaderboard" className="text-xs">
          Leaderboard
        </TabsTrigger>
        <TabsTrigger value="trades" className="text-xs">
          Trade History
        </TabsTrigger>
        <TabsTrigger value="timeline" className="text-xs">
          Leader Timeline
        </TabsTrigger>
      </TabsList>

      <TabsContent value="leaderboard" className="mt-3">
        <LeaderboardTable leaders={leaders} currentLeaderWallet={currentLeaderWallet} />
      </TabsContent>

      <TabsContent value="trades" className="mt-3">
        <TradeHistoryTable trades={trades} />
      </TabsContent>

      <TabsContent value="timeline" className="mt-3">
        {leaderHistory.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-slate-500">
            No leader history yet
          </div>
        ) : (
          <div className="space-y-3">
            {leaderHistory.map((entry) => {
              const pnlPositive = entry.pnl_during_tenure >= 0
              const active = entry.replaced_at == null
              return (
                <div
                  key={entry.id}
                  className={[
                    'relative flex gap-4 rounded-lg border p-4 text-sm',
                    active
                      ? 'border-emerald-400/30 bg-emerald-400/5'
                      : 'border-slate-800 bg-slate-900',
                  ].join(' ')}
                >
                  {/* Timeline dot */}
                  <div className="flex flex-col items-center pt-0.5">
                    <span
                      className={[
                        'h-2.5 w-2.5 rounded-full',
                        active ? 'bg-emerald-400 ring-2 ring-emerald-400/30' : 'bg-slate-600',
                      ].join(' ')}
                    />
                    {!active && (
                      <div className="mt-1 w-px flex-1 bg-slate-800" />
                    )}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-mono text-xs text-slate-200">
                        {entry.display_name ?? truncateWallet(entry.wallet_address)}
                      </span>
                      {active && (
                        <span className="text-[10px] font-medium text-emerald-400">Current</span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
                      <span>Since {formatDate(entry.became_leader_at)}</span>
                      {entry.replaced_at && (
                        <span>Until {formatDate(entry.replaced_at)}</span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span className="text-slate-400">
                        Trades copied:{' '}
                        <span className="text-slate-200 font-medium">{entry.trades_copied}</span>
                      </span>
                      <span className="text-slate-400">
                        P&amp;L:{' '}
                        <span className={pnlPositive ? 'text-emerald-400 font-medium' : 'text-red-400 font-medium'}>
                          {pnlPositive ? '+' : ''}
                          {entry.pnl_during_tenure.toFixed(2)} USDC
                        </span>
                      </span>
                      {entry.reason_replaced && (
                        <span className="text-slate-400">
                          Replaced:{' '}
                          <span className="text-slate-300">{entry.reason_replaced}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </TabsContent>
    </Tabs>
  )
}
