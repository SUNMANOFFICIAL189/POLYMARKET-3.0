'use client'

import { Leader } from '@/lib/types'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

interface LeaderboardTableProps {
  leaders: Leader[]
  currentLeaderWallet: string | null
}

function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.min(Math.max(score, 0), 100)
  return (
    <div className="flex items-center gap-2">
      <span className="w-9 text-right text-xs tabular-nums text-slate-200">
        {score.toFixed(1)}
      </span>
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-700">
        <div
          className="h-full rounded-full bg-emerald-400 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function LeaderboardTable({ leaders, currentLeaderWallet }: LeaderboardTableProps) {
  if (leaders.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-slate-500">
        No traders scored yet
      </div>
    )
  }

  // Sort: current leader first, then by composite_score desc
  const sorted = [...leaders].sort((a, b) => {
    if (a.is_current_leader && !b.is_current_leader) return -1
    if (!a.is_current_leader && b.is_current_leader) return 1
    return b.composite_score - a.composite_score
  })

  return (
    <Table>
      <TableHeader>
        <TableRow className="border-slate-800 hover:bg-transparent">
          <TableHead className="w-12 text-xs text-slate-400">Rank</TableHead>
          <TableHead className="text-xs text-slate-400">Wallet</TableHead>
          <TableHead className="text-xs text-slate-400">Score</TableHead>
          <TableHead className="text-xs text-slate-400">Win Rate</TableHead>
          <TableHead className="text-xs text-slate-400">P&amp;L (30d)</TableHead>
          <TableHead className="text-xs text-slate-400">Trades</TableHead>
          <TableHead className="text-xs text-slate-400">Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((leader, index) => {
          const isCurrent =
            leader.wallet_address === currentLeaderWallet || leader.is_current_leader
          const pnlPositive = leader.total_pnl_30d >= 0

          return (
            <TableRow
              key={leader.wallet_address}
              className={[
                'border-slate-800 transition-colors hover:bg-slate-800/50',
                isCurrent ? 'border-l-2 border-l-emerald-400 bg-emerald-400/5' : 'border-l-2 border-l-transparent',
              ].join(' ')}
            >
              {/* Rank */}
              <TableCell className="text-xs font-medium text-slate-400">
                {index + 1}
              </TableCell>

              {/* Wallet */}
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  {leader.display_name && (
                    <span className="text-xs font-medium text-slate-200">
                      {leader.display_name}
                    </span>
                  )}
                  <span className="font-mono text-xs text-slate-400">
                    {truncateWallet(leader.wallet_address)}
                  </span>
                </div>
              </TableCell>

              {/* Score bar */}
              <TableCell>
                <ScoreBar score={leader.composite_score} />
              </TableCell>

              {/* Win rate */}
              <TableCell className="text-xs text-slate-300 tabular-nums">
                {(leader.win_rate_30d * 100).toFixed(1)}%
              </TableCell>

              {/* P&L */}
              <TableCell
                className={[
                  'text-xs font-medium tabular-nums',
                  pnlPositive ? 'text-emerald-400' : 'text-red-400',
                ].join(' ')}
              >
                {pnlPositive ? '+' : ''}
                {leader.total_pnl_30d.toFixed(2)} USDC
              </TableCell>

              {/* Trade count */}
              <TableCell className="text-xs text-slate-300 tabular-nums">
                {leader.trade_count_30d}
              </TableCell>

              {/* Status */}
              <TableCell>
                {isCurrent ? (
                  <div className="flex items-center gap-1.5">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                    </span>
                    <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/30 text-[10px]">
                      Leader
                    </Badge>
                  </div>
                ) : (
                  <Badge variant="outline" className="border-slate-700 text-slate-500 text-[10px]">
                    Tracking
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
