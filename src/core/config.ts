import 'dotenv/config';
import { RISK_PRESETS, type RiskConfig, type RiskLevel } from '../types/index.js';
import { logger } from '../utils/logger.js';

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
  };
  rotation: {
    hysteresisMarginPct: number;
    hysteresisMinDurationMs: number;
  };
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
    },
    rotation: {
      hysteresisMarginPct: parseFloat(envOpt('ROTATION_MARGIN_PCT', '5')), // 5%
      hysteresisMinDurationMs: parseInt(envOpt('ROTATION_MIN_DURATION_MS', '3600000')), // 1 hour
    },
  };

  logger.info('Config loaded', {
    paperMode: config.paperMode,
    riskLevel: config.risk.level,
    capital: config.totalCapitalUsdc,
    hasAnthropicKey: !!config.apiKeys.anthropic,
    hasSupabase: !!config.supabase.url,
    glintEnabled: config.glint.enabled,
    leaderboardPollMs: config.leaderboard.pollIntervalMs,
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
