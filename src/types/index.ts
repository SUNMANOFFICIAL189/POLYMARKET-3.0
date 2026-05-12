import { z } from 'zod';

// ─── Pipeline IDs (Option D — isolated capital + risk per pipeline) ─────
export type PipelineId = 'signal' | 'copy' | 'geopolitics';

export const ALL_PIPELINES: PipelineId[] = ['signal', 'copy', 'geopolitics'];

export interface PipelineConfig {
  /** Stable identifier for this pipeline */
  id: PipelineId;
  /** Capital allocated to this pipeline (USDC) — drives risk gates independently */
  capital: number;
  /** Risk preset for this pipeline */
  riskLevel: RiskLevel;
  /** Whether this pipeline is currently active (false = no trades will be gated through it) */
  enabled: boolean;
}

// ─── Risk Levels ───────────────────────────────────────────────
export type RiskLevel = 'conservative' | 'moderate' | 'aggressive' | 'paper';

export const RiskConfig = z.object({
  level: z.enum(['conservative', 'moderate', 'aggressive', 'paper']),
  minConviction: z.number().min(0).max(100),
  maxPositionPct: z.number().min(0).max(1),
  maxOpenPositions: z.number().int().positive(),
  maxDailyRiskPct: z.number().min(0).max(1),
  minWhaleConsensus: z.number().int().min(0),
  stopLossPct: z.number().min(0).max(1),
});
export type RiskConfig = z.infer<typeof RiskConfig>;

export const RISK_PRESETS: Record<RiskLevel, RiskConfig> = {
  paper: {
    level: 'paper',
    minConviction: 40,
    // 2026-05-12: bumped 0.02 → 0.10. The 2% cap was set for global bot
    // capital ($6300 × 0.02 = $126); after Option D pipeline isolation
    // (2026-05-12), each per-pipeline RM uses its OWN pool balance, so 2%
    // of a $1500 geopolitics pool = $30 — silently rejected the $75 flat
    // sizing. The per-trade max-loss cap (MAX_LOSS_PCT_PER_TRADE=0.05) is
    // the real asymmetric-exposure safety gate; this percent is just a
    // sanity cap on dollar size.
    maxPositionPct: 0.10,
    maxOpenPositions: 5,
    maxDailyRiskPct: 0.05,
    minWhaleConsensus: 0,
    stopLossPct: 0.15,
  },
  conservative: {
    level: 'conservative',
    minConviction: 65,
    maxPositionPct: 0.03,
    maxOpenPositions: 3,
    maxDailyRiskPct: 0.05,
    minWhaleConsensus: 2,
    stopLossPct: 0.15,
  },
  moderate: {
    level: 'moderate',
    minConviction: 55,
    maxPositionPct: 0.05,
    maxOpenPositions: 5,
    maxDailyRiskPct: 0.08,
    minWhaleConsensus: 1,
    stopLossPct: 0.20,
  },
  aggressive: {
    level: 'aggressive',
    minConviction: 45,
    maxPositionPct: 0.10,
    maxOpenPositions: 8,
    maxDailyRiskPct: 0.12,
    minWhaleConsensus: 0,
    stopLossPct: 0.25,
  },
};

// ─── Market Types ──────────────────────────────────────────────
export interface Market {
  id: string;
  conditionId: string;
  questionId: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  volume: number;
  liquidity: number;
  outcomes: TokenInfo[];
  outcomePrices: number[];
  tokens: TokenInfo[];
  endDate: string;
  tags: string[];
}

export interface TokenInfo {
  tokenId: string;
  outcome: string;
  price: number;
}

// ─── Order Types ───────────────────────────────────────────────
export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

export interface OrderRequest {
  tokenId: string;
  side: Side;
  type: OrderType;
  amount: number;
  price?: number;
}

export interface OrderResult {
  orderId: string;
  status: 'live' | 'filled' | 'partial' | 'cancelled' | 'failed';
  filledAmount: number;
  avgPrice: number;
  timestamp: string;
}

// ─── Position Types ────────────────────────────────────────────
export interface Position {
  marketId: string;
  conditionId: string;
  question: string;
  tokenId: string;
  outcome: string;
  side: Side;
  size: number;
  avgEntry: number;
  currentPrice: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  timestamp: string;
}

// ─── Signal Types ──────────────────────────────────────────────
export type SignalSource = 'news' | 'whale' | 'orderbook' | 'social' | 'manual';

export interface RawSignal {
  id: string;
  source: SignalSource;
  headline: string;
  body?: string;
  url?: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface ScoredSignal extends RawSignal {
  impactScore: number;
  matchedMarkets: string[];
  direction: 'yes' | 'no' | 'neutral';
  confidence: number;
}

// ─── Trade Types ───────────────────────────────────────────────
export type TradeStatus = 'pending' | 'open' | 'closed' | 'stopped' | 'expired';

export interface Trade {
  id: string;
  marketId: string;
  question: string;
  tokenId: string;
  outcome: string;
  side: Side;
  entryPrice: number;
  exitPrice?: number;
  size: number;
  usdcAmount: number;
  convictionScore: number;
  riskLevel: RiskLevel;
  status: TradeStatus;
  pnl?: number;
  pnlPct?: number;
  stopLoss: number;
  signalIds: string[];
  entryTime: string | Date;
  exitTime?: string | Date;
  endDate?: string;
  /**
   * Pipeline that originated this trade. Set at construction by the pipeline's
   * executor. Used for attribution + per-pipeline P&L queries in Supabase
   * (column added in a follow-up commit; the in-memory field is non-breaking
   * until the column lands).  Option D, 2026-05-10.
   */
  pipelineId: PipelineId;
}

// ─── Wallet Types ──────────────────────────────────────────────
export interface WalletProfile {
  address: string;
  alias: string;
  totalPnl: number;
  winRate: number;
  recentTrades: number;
  lastActive: string;
  tracked: boolean;
}

// ─── Orderbook Types ───────────────────────────────────────────
export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  tokenId: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  spread: number;
  midpoint: number;
  timestamp: string;
}

// ─── Performance Types ─────────────────────────────────────────
export interface DailyPerformance {
  date: string;
  balance?: number;
  pnl: number;
  pnlPct: number;
  tradesExecuted: number;
  tradesVetoed: number;
  wins: number;
  losses: number;
  winRate: number;
  maxDrawdown: number;
  exposure: number;
  riskLevel: RiskLevel;
  leaderWallet?: string;
  leaderName?: string;
}

// ─── CLI Wrapper Types ─────────────────────────────────────────
export interface CLIResult<T = unknown> {
  success: boolean;
  data: T;
  raw: string;
  command: string;
  executionMs: number;
}

export interface CLIError {
  success: false;
  error: string;
  command: string;
  exitCode: number;
  stderr: string;
}

// ─── Leader Types ──────────────────────────────────────────────
export interface Leader {
  id?: string;
  walletAddress: string;
  displayName?: string;
  compositeScore: number;
  winRate30d: number;
  profitFactor14d: number;
  tradeCount30d: number;
  totalPnl30d: number;
  lastTradeTime?: string;
  isCurrentLeader: boolean;
  trackedSince?: string;
  updatedAt?: string;
}

export interface WatcherConfig {
  walletAddress: string;
  rank: number; // 1 = primary leader, 2-5 = watchers
}

export interface LeaderTrade {
  leaderWallet: string;
  marketId: string;
  marketQuestion: string;
  tokenId?: string;
  outcome: string;
  side: Side;
  entryPrice: number;
  size: number;
  timestamp: string;
  tradeId?: string;
  rank?: number; // 1 = leader, 2-5 = watcher
  specialistCategory?: string | null; // wallet's primary category (null = generalist, undefined = unknown)
  walletRollingWR?: number;
  walletRollingCount?: number;
  coldSizeMultiplier?: number;
  probationCap?: number;
}

export type CopyTradeStatus = 'pending' | 'open' | 'closed' | 'stopped' | 'vetoed';
export type ConfirmationDecision = 'approved' | 'vetoed' | 'skipped';

export interface CopyTrade {
  id?: string;
  /**
   * Pipeline that originated this trade — persisted to Supabase `pipeline` column
   * (added 2026-05-11 as part of Option D refactor). The legacy `source` field
   * remains for sub-classification within signal pipeline (signal vs movement).
   */
  pipeline: PipelineId;
  source?: 'copy' | 'signal' | 'movement';  // legacy sub-type — kept for backward compat
  leaderWallet: string;
  leaderTradeId?: string;
  marketId: string;
  marketQuestion: string;
  tokenId?: string;
  outcome: string;
  side: Side;
  leaderEntryPrice: number;
  ourEntryPrice?: number;
  entryPrice?: number;     // alias for ourEntryPrice — used by lifecycle stop-loss
  ourSize: number;
  confirmationResult: ConfirmationDecision | string;
  confirmationReason?: string;
  status: CopyTradeStatus | string;
  riskLevel: RiskLevel | string;
  pnl?: number;
  pnlPct?: number;
  entryTime: string;
  exitTime?: string;
  exitReason?: string;
  createdAt?: string;
  // Rolling wallet stats (previously smuggled via `as any`)
  walletRollingWR?: number;
  walletRollingCount?: number;
  // Sizing modifiers (previously smuggled via `as any`)
  coldSizeMultiplier?: number;
  probationCap?: number;
  watcherRank?: number; // rank of trader who triggered this copy (1-5)
}

// ─── Raw Data API Types ────────────────────────────────────────
export interface DataAPITrade {
  id: string;
  taker_order_id?: string;
  market: string;
  asset_id: string;
  outcome: string;
  price: number;
  size: number;
  side: string;
  timestamp: string;
  created_at: number;
  type: string;
  title?: string;
  slug?: string;
  condition_id?: string;
}

export interface DataAPIPosition {
  market: string;
  asset: string;
  outcome: string;
  price_per_share: number;
  quantity: number;
  quantity_owned: number;
  cash_balance: number;
  initial_value: number;
  current_value: number;
  profit_loss: number;
  profit_loss_percent: number;
  title: string;
  slug: string;
  condition_id: string;
}
