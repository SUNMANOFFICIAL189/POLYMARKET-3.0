import 'dotenv/config';
import { RISK_PRESETS, type RiskConfig, type RiskLevel } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface ConfirmationConfig {
  vetoConfidenceThreshold: number;
  watcherAiMinConfidence: number;
  watcherOutOfSpecialtyConfidence: number;
  watcherOrderbookThreshold: number;
  watcherMinCorroborations: number;
  maxTradeAgeMs: number;
  watcherMaxTradeAgeMs: number;
}

export interface PositionConfig {
  maxOpenPositions: number;
  rank1ReservedSlots: number;
  enableEdgeFloor: boolean;
  stalePositionDays: number;
}

export interface LiquidityConfig {
  enabled: boolean;
  maxSlippagePct: number;
}

export interface HoldToResolutionConfig {
  enabled: boolean;
  holdEntryThreshold: number;
  holdCurrentThreshold: number;
  cutLossEntryThreshold: number;
  cutLossCurrentThreshold: number;
}

export interface AppConfig {
  paperMode: boolean;
  risk: RiskConfig;
  totalCapitalUsdc: number;
  apiKeys: {
    anthropic: string;
  };
  supabase: {
    url: string;
    serviceKey: string;
  };
  glint: {
    enabled: boolean;
    headless: boolean;
  };
  leaderboard: {
    pollIntervalMs: number;
    topN: number;
  };
  walletMonitor: {
    pollIntervalMs: number;
    enableWebSocket: boolean;
  };
  rotation: {
    hysteresisMarginPct: number;
    hysteresisMinDurationMs: number;
  };
  confirmation: ConfirmationConfig;
  positions: PositionConfig;
  liquidity: LiquidityConfig;
  holdToResolution: HoldToResolutionConfig;
}

function envOpt(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export function loadConfig(): AppConfig {
  const paperMode = envOpt('PAPER_MODE', 'true') === 'true';

  let riskLevel: RiskLevel;
  if (paperMode) {
    riskLevel = 'paper';
    const envRisk = process.env.RISK_LEVEL;
    if (envRisk && envRisk !== 'paper') {
      logger.warn(`PAPER_MODE=true overrides RISK_LEVEL=${envRisk} → using 'paper' preset. Set PAPER_MODE=false to use ${envRisk}.`);
    }
  } else {
    const envRisk = envOpt('RISK_LEVEL', 'conservative') as RiskLevel;
    riskLevel = RISK_PRESETS[envRisk] ? envRisk : 'conservative';
  }

  const risk = RISK_PRESETS[riskLevel];
  if (!risk) throw new Error(`Invalid RISK_LEVEL: ${riskLevel}`);

  // Override maxOpenPositions from env if provided
  const maxOpenOverride = process.env.MAX_OPEN_POSITIONS;
  if (maxOpenOverride) {
    risk.maxOpenPositions = parseInt(maxOpenOverride);
  }

  const config: AppConfig = {
    paperMode,
    risk,
    totalCapitalUsdc: parseFloat(envOpt('TOTAL_CAPITAL_USDC', '6300')),
    apiKeys: {
      anthropic: envOpt('ANTHROPIC_API_KEY', ''),
    },
    supabase: {
      url: envOpt('SUPABASE_URL', ''),
      serviceKey: envOpt('SUPABASE_SERVICE_KEY', ''),
    },
    glint: {
      enabled: envOpt('ENABLE_GLINT', 'true') === 'true',
      headless: envOpt('GLINT_HEADLESS', 'true') === 'true',
    },
    leaderboard: {
      pollIntervalMs: parseInt(envOpt('LEADERBOARD_POLL_MS', '300000')), // 5 minutes
      topN: parseInt(envOpt('LEADERBOARD_TOP_N', '20')),
    },
    walletMonitor: {
      pollIntervalMs: parseInt(envOpt('WALLET_POLL_MS', '30000')), // 30 seconds
      enableWebSocket: envOpt('ENABLE_WS_MONITOR', 'false') === 'true',
    },
    rotation: {
      hysteresisMarginPct: parseFloat(envOpt('ROTATION_MARGIN_PCT', '5')), // 5%
      hysteresisMinDurationMs: parseInt(envOpt('ROTATION_MIN_DURATION_MS', '3600000')), // 1 hour
    },
    confirmation: {
      vetoConfidenceThreshold: parseFloat(envOpt('VETO_CONFIDENCE_THRESHOLD', '0.85')),
      watcherAiMinConfidence: parseFloat(envOpt('WATCHER_AI_MIN_CONFIDENCE', '0.65')),
      watcherOutOfSpecialtyConfidence: parseFloat(envOpt('WATCHER_OUT_OF_SPECIALTY_CONFIDENCE', '0.75')),
      watcherOrderbookThreshold: parseFloat(envOpt('WATCHER_ORDERBOOK_THRESHOLD', '0.55')),
      watcherMinCorroborations: parseInt(envOpt('WATCHER_MIN_CORROBORATIONS', '1')),
      maxTradeAgeMs: parseInt(envOpt('MAX_TRADE_AGE_MS', '300000')),
      watcherMaxTradeAgeMs: parseInt(envOpt('WATCHER_MAX_TRADE_AGE_MS', '900000')),
    },
    positions: {
      maxOpenPositions: risk.maxOpenPositions,
      rank1ReservedSlots: parseInt(envOpt('RANK1_RESERVED_SLOTS', '2')),
      enableEdgeFloor: envOpt('ENABLE_EDGE_FLOOR', 'false') === 'true',
      stalePositionDays: parseInt(envOpt('STALE_POSITION_DAYS', '7')),
    },
    liquidity: {
      enabled: envOpt('ENABLE_LIQUIDITY_CHECK', 'true') === 'true',
      maxSlippagePct: parseFloat(envOpt('MAX_SLIPPAGE_PCT', '0.02')),
    },
    holdToResolution: {
      enabled: envOpt('ENABLE_HOLD_TO_RESOLUTION', 'false') === 'true',
      holdEntryThreshold: parseFloat(envOpt('HOLD_ENTRY_THRESHOLD', '0.35')),
      holdCurrentThreshold: parseFloat(envOpt('HOLD_CURRENT_THRESHOLD', '0.60')),
      cutLossEntryThreshold: parseFloat(envOpt('CUT_LOSS_ENTRY_THRESHOLD', '0.70')),
      cutLossCurrentThreshold: parseFloat(envOpt('CUT_LOSS_CURRENT_THRESHOLD', '0.50')),
    },
  };

  logger.info('Config loaded', {
    paperMode: config.paperMode,
    riskLevel: config.risk.level,
    capital: config.totalCapitalUsdc,
    hasSupabase: !!config.supabase.url,
    glintEnabled: config.glint.enabled,
    leaderboardPollMs: config.leaderboard.pollIntervalMs,
    vetoThreshold: config.confirmation.vetoConfidenceThreshold,
    watcherCorroborations: config.confirmation.watcherMinCorroborations,
    maxOpenPositions: config.positions.maxOpenPositions,
    edgeFloor: config.positions.enableEdgeFloor,
    liquidityCheck: config.liquidity.enabled,
    holdToResolution: config.holdToResolution.enabled,
  });

  return config;
}

export class RiskDial {
  private currentLevel: RiskLevel;
  private consecutiveWins = 0;
  private consecutiveLosses = 0;

  constructor(initial: RiskLevel = 'conservative') {
    this.currentLevel = initial;
  }

  get config(): RiskConfig { return RISK_PRESETS[this.currentLevel]; }
  get level(): RiskLevel { return this.currentLevel; }

  getCurrentPreset(): RiskConfig { return this.config; }
  getCurrentLevel(): RiskLevel { return this.level; }

  recordWin(): void {
    this.consecutiveWins++;
    this.consecutiveLosses = 0;
    if (this.consecutiveWins >= 10) { this.upgrade(); this.consecutiveWins = 0; }
  }

  recordLoss(): void {
    this.consecutiveLosses++;
    this.consecutiveWins = 0;
    if (this.consecutiveLosses >= 3) { this.downgrade(); this.consecutiveLosses = 0; }
  }

  private upgrade(): void {
    const order: RiskLevel[] = ['paper', 'conservative', 'moderate', 'aggressive'];
    const idx = order.indexOf(this.currentLevel);
    if (idx < order.length - 1) {
      const prev = this.currentLevel;
      this.currentLevel = order[idx + 1];
      logger.info(`Risk dial UPGRADED: ${prev} -> ${this.currentLevel}`);
    }
  }

  private downgrade(): void {
    const order: RiskLevel[] = ['paper', 'conservative', 'moderate', 'aggressive'];
    const idx = order.indexOf(this.currentLevel);
    if (idx > 0) {
      const prev = this.currentLevel;
      this.currentLevel = order[idx - 1];
      logger.warn(`Risk dial DOWNGRADED: ${prev} -> ${this.currentLevel}`);
    }
  }

  maxPositionSize(totalCapital: number): number { return totalCapital * this.config.maxPositionPct; }
  maxExposure(totalCapital: number): number { return totalCapital * this.config.maxPositionPct * this.config.maxOpenPositions; }
  maxDailyLoss(totalCapital: number): number { return totalCapital * this.config.maxDailyRiskPct; }

  toJSON() {
    return { level: this.currentLevel, consecutiveWins: this.consecutiveWins, consecutiveLosses: this.consecutiveLosses, config: this.config };
  }
}
