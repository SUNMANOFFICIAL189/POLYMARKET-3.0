'use client'

interface ConfirmationIconsProps {
  glint: boolean
  ai: boolean
  news: boolean
  aiConfidence: number | null
}

export function ConfirmationIcons({
  glint,
  ai,
  news,
  aiConfidence,
}: ConfirmationIconsProps) {
  return (
    <div className="flex items-center gap-1.5">
      {/* Glint */}
      <span
        title={glint ? 'Glint confirmed' : 'Glint not confirmed'}
        className={[
          'inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none',
          glint
            ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40'
            : 'bg-slate-700/50 text-slate-500 ring-1 ring-slate-600/40',
        ].join(' ')}
      >
        G
      </span>

      {/* AI */}
      <span
        title={
          ai
            ? `AI confirmed${aiConfidence !== null ? ` (${aiConfidence}%)` : ''}`
            : 'AI not confirmed'
        }
        className={[
          'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none',
          ai
            ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40'
            : 'bg-slate-700/50 text-slate-500 ring-1 ring-slate-600/40',
        ].join(' ')}
      >
        AI
        {ai && aiConfidence !== null && (
          <span className="text-emerald-300/80">{aiConfidence}%</span>
        )}
        {!ai && aiConfidence !== null && (
          <span className="text-slate-500/80">{aiConfidence}%</span>
        )}
      </span>

      {/* News */}
      <span
        title={news ? 'News confirmed' : 'News not confirmed'}
        className={[
          'inline-flex items-center justify-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none',
          news
            ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40'
            : 'bg-slate-700/50 text-slate-500 ring-1 ring-slate-600/40',
        ].join(' ')}
      >
        N
      </span>
    </div>
  )
}
