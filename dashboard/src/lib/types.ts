export interface Leader {
  wallet_address: string
  display_name: string | null
  composite_score: number
  win_rate_30d: number
  profit_factor_14d: number
  trade_count_30d: number
  total_pnl_30d: number
  last_trade_time: string | null
  is_current_leader: boolean
  tracked_since: string
  updated_at: string
}

export interface LeaderHistory {
  id: string
  wallet_address: string
  display_name: string | null
  became_leader_at: string
  replaced_at: string | null
  reason_replaced: string | null
  trades_copied: number
  pnl_during_tenure: number
}

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

export interface DailyPerformance {
  id: string
  date: string
  balance_usdc: number
  pnl_usdc: number
  pnl_pct: number
  trades_opened: number
  trades_closed: number
  win_count: number
  loss_count: number
  win_rate: number | null
}

export interface SystemStatus {
  leader: Leader | null
  balance: number
  totalReturn: number
  openPositions: number
  closedTrades: number
  winRate: number | null
  glintUp: boolean
  paperMode: boolean
}
