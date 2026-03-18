'use client'

import { LeaderHistory } from '@/lib/types'
import { User2, TrendingUp, TrendingDown, Clock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'

interface LeaderTimelineProps {
  history: LeaderHistory[]
}

function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function reasonLabel(reason: string | null): string {
  if (!reason) return 'Unknown'
  return reason
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export function LeaderTimeline({ history }: LeaderTimelineProps) {
  if (history.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-slate-500">
        No leader history yet
      </div>
    )
  }

  // Sort: current leader (replaced_at = null) first, then newest became_leader_at
  const sorted = [...history].sort((a, b) => {
    if (a.replaced_at === null && b.replaced_at !== null) return -1
    if (a.replaced_at !== null && b.replaced_at === null) return 1
    return new Date(b.became_leader_at).getTime() - new Date(a.became_leader_at).getTime()
  })

  return (
    <div className="relative flex flex-col gap-0">
      {sorted.map((entry, index) => {
        const isCurrent = entry.replaced_at === null
        const pnlPositive = entry.pnl_during_tenure >= 0
        const isLast = index === sorted.length - 1

        return (
          <div key={entry.id} className="relative flex gap-4">
            {/* Timeline track + dot */}
            <div className="flex flex-col items-center">
              {/* Dot */}
              <div className="relative mt-4 flex h-4 w-4 shrink-0 items-center justify-center">
                {isCurrent ? (
                  <>
                    <span className="absolute inline-flex h-4 w-4 animate-ping rounded-full bg-emerald-400 opacity-40" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-400 shadow-[0_0_6px_2px_rgba(52,211,153,0.5)]" />
                  </>
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full bg-slate-600" />
                )}
              </div>
              {/* Vertical connector */}
              {!isLast && (
                <div className="w-px flex-1 bg-slate-700" style={{ minHeight: '1.5rem' }} />
              )}
            </div>

            {/* Card */}
            <div
              className={[
                'mb-4 flex-1 rounded-lg border p-4 transition-colors',
                isCurrent
                  ? 'border-emerald-400/30 bg-emerald-400/5'
                  : 'border-slate-800 bg-slate-900',
              ].join(' ')}
            >
              {/* Header row */}
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <User2 className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="flex flex-col gap-0.5">
                    {entry.display_name && (
                      <span className="text-sm font-medium text-slate-200">
                        {entry.display_name}
                      </span>
                    )}
                    <span className="font-mono text-xs text-slate-400">
                      {truncateWallet(entry.wallet_address)}
                    </span>
                  </div>
                </div>

                {/* Tenure badge */}
                {isCurrent ? (
                  <Badge className="bg-emerald-400/10 text-emerald-400 border-emerald-400/30 text-[10px]">
                    Current
                  </Badge>
                ) : entry.reason_replaced ? (
                  <Badge
                    variant="outline"
                    className="border-slate-700 text-slate-400 text-[10px]"
                  >
                    {reasonLabel(entry.reason_replaced)}
                  </Badge>
                ) : null}
              </div>

              {/* Date range */}
              <div className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
                <Clock className="h-3 w-3" />
                <span>{formatDate(entry.became_leader_at)}</span>
                <span className="text-slate-700">—</span>
                <span>
                  {entry.replaced_at ? formatDate(entry.replaced_at) : 'Current'}
                </span>
              </div>

              {/* Stats row */}
              <div className="mt-3 flex flex-wrap items-center gap-4">
                {/* P&L */}
                <div className="flex items-center gap-1.5">
                  {pnlPositive ? (
                    <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <TrendingDown className="h-3.5 w-3.5 text-red-400" />
                  )}
                  <span
                    className={[
                      'text-xs font-medium tabular-nums',
                      pnlPositive ? 'text-emerald-400' : 'text-red-400',
                    ].join(' ')}
                  >
                    {pnlPositive ? '+' : ''}
                    {entry.pnl_during_tenure.toFixed(2)} USDC
                  </span>
                  <span className="text-xs text-slate-600">P&amp;L</span>
                </div>

                {/* Trades copied */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium tabular-nums text-slate-300">
                    {entry.trades_copied}
                  </span>
                  <span className="text-xs text-slate-600">trades copied</span>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
