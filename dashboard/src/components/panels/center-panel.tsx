'use client'

import { PnlChart } from '@/components/charts/pnl-chart'
import type { DailyPerformance, CopyTrade } from '@/lib/types'

interface CenterPanelProps {
  performanceData: DailyPerformance[]
  recentTrades: CopyTrade[]
  currentBalance: number
  highWaterMark?: number
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function formatUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

function getActionLabel(trade: CopyTrade): string {
  switch (trade.status) {
    case 'open':
      return `EXECUTED ${trade.side}`
    case 'closed':
      return `SETTLED ${trade.side}`
    case 'vetoed':
      return 'VETOED'
    case 'skipped':
      return 'SKIPPED'
    default:
      return (trade.status as string).toUpperCase()
  }
}

function getActionColor(trade: CopyTrade): string {
  switch (trade.status) {
    case 'open':
      return 'var(--green)'
    case 'closed':
      return '#888888'
    case 'vetoed':
      return 'var(--red)'
    case 'skipped':
      return 'var(--yellow)'
    default:
      return 'var(--text-muted)'
  }
}

interface TradeRowProps {
  trade: CopyTrade
  index: number
}

function TradeRow({ trade, index }: TradeRowProps) {
  const isEven = index % 2 === 0
  const actionLabel = getActionLabel(trade)
  const actionColor = getActionColor(trade)
  const hasPnl = trade.pnl_usdc !== null && trade.pnl_usdc !== undefined
  const pnlPositive = hasPnl && (trade.pnl_usdc as number) >= 0

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '34px 1fr 150px 64px',
        alignItems: 'center',
        height: '18px',
        padding: '0 8px',
        background: isEven ? '#000000' : '#050505',
        fontFamily: 'var(--font-mono)',
        fontSize: '10px',
        lineHeight: '18px',
        gap: '6px',
        flexShrink: 0,
      }}
    >
      {/* Timestamp */}
      <span style={{ color: '#444444', whiteSpace: 'nowrap' }}>
        {formatTime(trade.opened_at)}
      </span>

      {/* Action */}
      <span
        style={{
          color: actionColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          letterSpacing: '0.03em',
        }}
      >
        {actionLabel}
      </span>

      {/* Market name */}
      <span
        style={{
          color: 'var(--text-muted)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        title={trade.market_question}
      >
        {truncate(trade.market_question, 25)}
      </span>

      {/* P&L */}
      <span
        style={{
          color: hasPnl
            ? pnlPositive
              ? 'var(--green)'
              : 'var(--red)'
            : 'transparent',
          textAlign: 'right',
          whiteSpace: 'nowrap',
        }}
      >
        {hasPnl
          ? `${pnlPositive ? '+' : ''}${formatUSD(trade.pnl_usdc as number)}`
          : '—'}
      </span>
    </div>
  )
}

export function CenterPanel({
  performanceData,
  recentTrades,
  currentBalance,
  highWaterMark,
}: CenterPanelProps) {
  const displayTrades = recentTrades.slice(0, 20)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'transparent',
        overflow: 'hidden',
      }}
    >
      {/* ── P&L Chart Section ── */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        {/* Balance label top-right */}
        <div
          style={{
            position: 'absolute',
            top: '6px',
            right: '10px',
            zIndex: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--text)',
            letterSpacing: '0.04em',
            pointerEvents: 'none',
          }}
        >
          {formatUSD(currentBalance)}
          {highWaterMark !== undefined && (
            <span
              style={{
                fontSize: '8px',
                color: 'var(--text-muted)',
                marginLeft: '6px',
                letterSpacing: '0.08em',
              }}
            >
              HWM {formatUSD(highWaterMark)}
            </span>
          )}
        </div>

        <PnlChart data={performanceData} />
      </div>

      {/* Divider */}
      <div
        style={{
          height: '1px',
          background: 'var(--border)',
          flexShrink: 0,
        }}
      />

      {/* ── Activity Feed Section ── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {/* Section header */}
        <div
          style={{
            padding: '5px 8px 4px',
            fontFamily: 'var(--font-mono)',
            fontSize: '9px',
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            flexShrink: 0,
            borderBottom: '1px solid var(--border)',
          }}
        >
          ◆ ACTIVITY FEED
        </div>

        {/* Column headers */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '34px 1fr 150px 64px',
            height: '16px',
            padding: '0 8px',
            gap: '6px',
            background: '#050505',
            borderBottom: '1px solid var(--border)',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          {['TIME', 'ACTION', 'MARKET', 'PNL'].map((col, i) => (
            <span
              key={col}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '8px',
                letterSpacing: '0.12em',
                color: 'var(--text-dim)',
                textAlign: i === 3 ? 'right' : 'left',
              }}
            >
              {col}
            </span>
          ))}
        </div>

        {/* Scrollable rows */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            minHeight: 0,
          }}
        >
          {displayTrades.length === 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '60px',
                fontFamily: 'var(--font-mono)',
                fontSize: '9px',
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
                color: '#333333',
              }}
            >
              NO ACTIVITY
            </div>
          ) : (
            displayTrades.map((trade, i) => (
              <TradeRow key={trade.id} trade={trade} index={i} />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
