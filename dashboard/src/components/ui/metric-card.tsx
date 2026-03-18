import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  value: string | number
  subtitle?: string
  trend?: 'up' | 'down' | 'neutral'
  className?: string
  icon?: React.ReactNode
}

export function MetricCard({ title, value, subtitle, trend, className, icon }: MetricCardProps) {
  const trendColor = trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-red-400' : 'text-slate-400'
  return (
    <Card className={cn('bg-slate-900 border-slate-800', className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-slate-400">{title}</CardTitle>
        {icon && <div className="text-slate-500">{icon}</div>}
      </CardHeader>
      <CardContent>
        <div className={cn('text-2xl font-bold', trendColor)}>{value}</div>
        {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  )
}
