import { cn } from '@/lib/utils'

interface StatusDotProps {
  status: 'live' | 'paper' | 'down' | 'warning'
  label?: string
  className?: string
}

const statusConfig = {
  live:    { color: 'bg-emerald-400', pulse: true,  text: 'text-emerald-400' },
  paper:   { color: 'bg-yellow-400',  pulse: true,  text: 'text-yellow-400'  },
  down:    { color: 'bg-red-500',     pulse: false, text: 'text-red-400'     },
  warning: { color: 'bg-orange-400',  pulse: true,  text: 'text-orange-400'  },
}

export function StatusDot({ status, label, className }: StatusDotProps) {
  const cfg = statusConfig[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className="relative flex h-2 w-2">
        {cfg.pulse && (
          <span className={cn('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75', cfg.color)} />
        )}
        <span className={cn('relative inline-flex rounded-full h-2 w-2', cfg.color)} />
      </span>
      {label && <span className={cn('text-xs font-medium', cfg.text)}>{label}</span>}
    </span>
  )
}
