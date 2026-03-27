'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { ChartPoint } from '@/lib/types'

interface PnlChartProps {
  data: ChartPoint[]
}

function formatUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{ value: number; payload: ChartPoint }>
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0]?.payload
  if (!point) return null

  return (
    <div
      style={{
        background: '#0a0a0a',
        border: '1px solid #222222',
        padding: '5px 9px',
        fontFamily: 'var(--font-mono)',
        fontSize: '9px',
        letterSpacing: '0.05em',
        lineHeight: '1.6',
      }}
    >
      <div style={{ color: '#555555', marginBottom: '2px' }}>{point.time}</div>
      <div style={{ color: '#e8e8e8' }}>
        BAL <span style={{ color: '#ffffff' }}>{formatUSD(point.balance)}</span>
      </div>
    </div>
  )
}

export function PnlChart({ data }: PnlChartProps) {
  if (data.length <= 1) {
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
        AWAITING TRADES
      </div>
    )
  }

  const balances = data.map(d => d.balance)
  const minBal = Math.min(...balances)
  const maxBal = Math.max(...balances)
  const pad = (maxBal - minBal) * 0.15 || 200
  const yMin = Math.floor((minBal - pad) / 100) * 100
  const yMax = Math.ceil((maxBal + pad) / 100) * 100

  // Determine line colour: green if above initial deposit, red if below
  const INITIAL_DEPOSIT = 6300
  const endBal = data[data.length - 1]?.balance ?? 0
  const lineColor = endBal >= INITIAL_DEPOSIT ? '#00ff88' : '#ff3b3b'
  const gradientColor = endBal >= INITIAL_DEPOSIT ? 'rgba(0,255,136,' : 'rgba(255,59,59,'

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 10, right: 8, left: 2, bottom: 0 }}>
        <defs>
          <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`${gradientColor}0.12)`} />
            <stop offset="100%" stopColor={`${gradientColor}0)`} />
          </linearGradient>
        </defs>

        <XAxis
          dataKey="time"
          stroke="#222222"
          tick={{ fill: '#444444', fontSize: 8, fontFamily: 'monospace' }}
          axisLine={{ stroke: '#222222' }}
          tickLine={false}
          interval="preserveStartEnd"
        />

        <YAxis
          domain={[yMin, yMax]}
          tickFormatter={(v: number) => formatUSD(v)}
          stroke="#222222"
          tick={{ fill: '#444444', fontSize: 8, fontFamily: 'monospace' }}
          axisLine={{ stroke: '#222222' }}
          tickLine={false}
          width={60}
        />

        <Tooltip
          content={<CustomTooltip />}
          cursor={{ stroke: '#333333', strokeWidth: 1, strokeDasharray: '3 3' }}
        />

        <Area
          type="stepAfter"
          dataKey="balance"
          stroke={lineColor}
          strokeWidth={1.5}
          fill="url(#pnlGradient)"
          dot={false}
          activeDot={{ r: 3, fill: lineColor, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
