'use client'

import { useState } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { ConfirmationIcons } from './confirmation-icons'

// ---------- Types ----------

export interface CopyTrade {
  id: string
  leader_wallet: string
  market_id: string
  market_question: string
  side: 'YES' | 'NO'
  size_usdc: number
  price: number
  confirmation_glint: boolean
  confirmation_ai: boolean
  confirmation_news: boolean
  ai_confidence: number | null
  status: 'open' | 'closed' | 'vetoed' | 'skipped'
  paper_mode: boolean
  pnl_usdc: number | null
  opened_at: string
  closed_at: string | null
  veto_reason: string | null
}

type FilterValue = 'all' | 'open' | 'closed' | 'vetoed'

// ---------- Helpers ----------

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str
}

// ---------- Sub-components ----------

function SideBadge({ side }: { side: 'YES' | 'NO' }) {
  if (side === 'YES') {
    return (
      <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/40 font-bold text-xs">
        YES
      </Badge>
    )
  }
  return (
    <Badge className="bg-red-500/20 text-red-400 border-red-500/40 font-bold text-xs">
      NO
    </Badge>
  )
}

function StatusBadge({
  status,
  vetoReason,
}: {
  status: CopyTrade['status']
  vetoReason: string | null
}) {
  const title =
    status === 'vetoed' && vetoReason ? vetoReason : undefined

  switch (status) {
    case 'open':
      return (
        <Badge
          title={title}
          className="cursor-default bg-yellow-500/20 text-yellow-400 border-yellow-500/40 text-[10px] uppercase tracking-wide"
        >
          open
        </Badge>
      )
    case 'closed':
      return (
        <Badge
          title={title}
          className="cursor-default bg-slate-600/40 text-slate-300 border-slate-500/40 text-[10px] uppercase tracking-wide"
        >
          closed
        </Badge>
      )
    case 'vetoed':
      return (
        <Badge
          title={title}
          className="cursor-default bg-red-500/20 text-red-400 border-red-500/40 text-[10px] uppercase tracking-wide"
        >
          vetoed
        </Badge>
      )
    case 'skipped':
      return (
        <Badge
          title={title}
          className="cursor-default bg-slate-700/50 text-slate-500 border-slate-600/40 text-[10px] uppercase tracking-wide"
        >
          skipped
        </Badge>
      )
  }
}

function PnlCell({
  pnl,
  status,
}: {
  pnl: number | null
  status: CopyTrade['status']
}) {
  if (status !== 'closed' || pnl === null) {
    return <span className="text-slate-600">—</span>
  }
  const isPositive = pnl >= 0
  return (
    <span
      className={[
        'font-mono text-sm font-semibold tabular-nums',
        isPositive ? 'text-emerald-400' : 'text-red-400',
      ].join(' ')}
    >
      {isPositive ? '+' : ''}${pnl.toFixed(2)}
    </span>
  )
}

// ---------- Filter button ----------

function FilterButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded px-3 py-1 text-xs font-semibold transition-colors',
        active
          ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40'
          : 'bg-slate-800 text-slate-400 ring-1 ring-slate-700 hover:bg-slate-700 hover:text-slate-200',
      ].join(' ')}
    >
      {label}
    </button>
  )
}

// ---------- Main component ----------

interface TradeHistoryTableProps {
  trades: CopyTrade[]
}

export function TradeHistoryTable({ trades }: TradeHistoryTableProps) {
  const [filter, setFilter] = useState<FilterValue>('all')

  // Sort newest first
  const sorted = [...trades].sort(
    (a, b) =>
      new Date(b.opened_at).getTime() - new Date(a.opened_at).getTime(),
  )

  const filtered =
    filter === 'all' ? sorted : sorted.filter((t) => t.status === filter)

  const filters: { label: string; value: FilterValue }[] = [
    { label: 'All', value: 'all' },
    { label: 'Open', value: 'open' },
    { label: 'Closed', value: 'closed' },
    { label: 'Vetoed', value: 'vetoed' },
  ]

  return (
    <div className="rounded-xl bg-slate-900 ring-1 ring-slate-800">
      {/* Filter row */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-500">
          Filter
        </span>
        {filters.map((f) => (
          <FilterButton
            key={f.value}
            label={f.label}
            active={filter === f.value}
            onClick={() => setFilter(f.value)}
          />
        ))}
        <span className="ml-auto text-xs text-slate-600">
          {filtered.length} trade{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow className="border-slate-800 hover:bg-transparent">
            <TableHead className="pl-5 text-xs text-slate-400">Time</TableHead>
            <TableHead className="text-xs text-slate-400">Market</TableHead>
            <TableHead className="text-xs text-slate-400">Side</TableHead>
            <TableHead className="text-xs text-slate-400">Size</TableHead>
            <TableHead className="text-xs text-slate-400">Price</TableHead>
            <TableHead className="text-xs text-slate-400">Confirmations</TableHead>
            <TableHead className="text-xs text-slate-400">Status</TableHead>
            <TableHead className="pr-5 text-xs text-slate-400">P&amp;L</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {filtered.length === 0 ? (
            <TableRow className="border-0 hover:bg-transparent">
              <TableCell
                colSpan={8}
                className="py-12 text-center text-sm text-slate-600"
              >
                No trades recorded yet
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((trade) => (
              <TableRow
                key={trade.id}
                className="border-slate-800 transition-colors hover:bg-slate-800/50"
              >
                {/* Time */}
                <TableCell className="pl-5 font-mono text-xs text-slate-400 whitespace-nowrap">
                  {formatDate(trade.opened_at)}
                </TableCell>

                {/* Market */}
                <TableCell className="max-w-[240px]">
                  <div className="flex items-center gap-2">
                    <span
                      title={trade.market_question}
                      className="cursor-default truncate text-slate-200 text-xs"
                    >
                      {truncate(trade.market_question, 50)}
                    </span>
                    {trade.paper_mode && (
                      <Badge className="shrink-0 bg-yellow-500/20 text-yellow-400 border-yellow-500/40 text-[10px] font-bold uppercase tracking-wide">
                        PAPER
                      </Badge>
                    )}
                  </div>
                </TableCell>

                {/* Side */}
                <TableCell>
                  <SideBadge side={trade.side} />
                </TableCell>

                {/* Size */}
                <TableCell className="font-mono text-xs text-slate-300 tabular-nums whitespace-nowrap">
                  ${trade.size_usdc.toFixed(2)}
                </TableCell>

                {/* Price */}
                <TableCell className="font-mono text-xs text-slate-300 tabular-nums whitespace-nowrap">
                  {(trade.price * 100).toFixed(1)}¢
                </TableCell>

                {/* Confirmations */}
                <TableCell>
                  <ConfirmationIcons
                    glint={trade.confirmation_glint}
                    ai={trade.confirmation_ai}
                    news={trade.confirmation_news}
                    aiConfidence={trade.ai_confidence}
                  />
                </TableCell>

                {/* Status */}
                <TableCell>
                  <StatusBadge
                    status={trade.status}
                    vetoReason={trade.veto_reason}
                  />
                </TableCell>

                {/* P&L */}
                <TableCell className="pr-5">
                  <PnlCell pnl={trade.pnl_usdc} status={trade.status} />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
