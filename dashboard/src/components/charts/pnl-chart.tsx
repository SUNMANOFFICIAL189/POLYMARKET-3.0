'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { DailyPerformance } from '@/lib/types'

interface PnlChartProps {
  data: DailyPerformance[]
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

interface TooltipPayloadEntry {
  value: number
  dataKey: string
  payload: DailyPerformance & { dateLabel: string }
}

interface CustomTooltipProps {
  active?: boolean
  payload?: TooltipPayloadEntry[]
  label?: string
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null

  const entry = payload[0]?.payload
  if (!entry) return null

  const pnlPositive = entry.pnl_usdc >= 0

  return (
    <div
      style={{
        background: '#0a0a0a',
        border: '1px solid #222222',
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)',
        fontSize: '9px',
        letterSpacing: '0.05em',
        lineHeight: '1.6',
      }}
    >
      <div style={{ color: '#888888', marginBottom: '4px', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ color: '#e8e8e8' }}>
        BAL{' '}
        <span style={{ color: '#ffffff' }}>{formatUSD(entry.balance_usdc)}</span>
      </div>
      <div style={{ color: '#888888' }}>
        PNL{' '}
        <span style={{ color: pnlPositive ? 'var(--green)' : 'var(--red)' }}>
          {pnlPositive ? '+' : ''}
          {formatUSD(entry.pnl_usdc)}
        </span>
      </div>
    </div>
  )
}

export function PnlChart({ data }: PnlChartProps) {
  if (data.length === 0) {
    return (
      <div
        style={{
          width: '100%',
          height: '220px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: '9px',
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          color: '#333333',
        }}
      >
        NO PERFORMANCE DATA
      </div>
    )
  }

  const chartData = data.map((d) => ({
    ...d,
    dateLabel: formatDate(d.date),
  }))

  const balances = data.map((d) => d.balance_usdc)
  const minBal = Math.min(...balances)
  const maxBal = Math.max(...balances)
  const pad = (maxBal - minBal) * 0.1 || 100
  const yMin = Math.floor((minBal - pad) / 100) * 100
  const yMax = Math.ceil((maxBal + pad) / 100) * 100

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={chartData} margin={{ top: 6, right: 6, left: 2, bottom: 0 }}>
        <defs>
          <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.08)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>

        <CartesianGrid
          strokeDasharray="2 4"
          stroke="#111111"
          vertical={false}
        />

        <XAxis
          dataKey="dateLabel"
          stroke="#333333"
          tick={{ fill: '#444444', fontSize: 9, fontFamily: 'monospace' }}
          axisLine={{ stroke: '#333333' }}
          tickLine={false}
          interval="preserveStartEnd"
        />

        <YAxis
          domain={[yMin, yMax]}
          tickFormatter={(v: number) => formatUSD(v)}
          stroke="#333333"
          tick={{ fill: '#444444', fontSize: 9, fontFamily: 'monospace' }}
          axisLine={{ stroke: '#333333' }}
          tickLine={false}
          width={64}
        />

        <Tooltip
          content={<CustomTooltip />}
          cursor={{ stroke: '#333333', strokeWidth: 1 }}
        />

        <Area
          type="monotone"
          dataKey="balance_usdc"
          stroke="#ffffff"
          strokeWidth={1.5}
          fill="url(#pnlGradient)"
          dot={false}
          activeDot={{ r: 3, fill: '#ffffff', strokeWidth: 0 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
