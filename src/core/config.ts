import 'dotenv/config';
import { RISK_PRESETS, ALL_PIPELINES, type PipelineConfig, type PipelineId, type RiskConfig, type RiskLevel } from '../types/index.js';
import { logger } from '../utils/logger.js';

export interface AppConfig {
  paperMode: boolean;
  risk: RiskConfig;
  totalCapitalUsdc: number;
  /**
   * Per-pipeline capital + risk allocation (Option D, 2026-05-10).
   * Each pipeline has its own RiskManager instance with isolated balance/drawdown
   * tracking. A bad day on one pipeline cannot reduce another pipeline's risk
   * gates. See vault Decision Log "Architecture decision: Option D".
   *
   * Default proportional split if no per-pipeline env vars are set:
   *   signal: 60% of total | copy: 30% | geopolitics: 10%
   * Env overrides: SIGNAL_CAPITAL, COPY_CAPITAL, GEOPOLITICS_CAPITAL.
   * If any env var is set, it overrides the proportional default for that pipeline.
   */
  pipelines: Record<PipelineId, PipelineConfig>;
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

/**
 * Default capital allocation when no env override is set.
 *
 * Designed to PRESERVE current bot behaviour (signal pipeline gets 100% of
 * capital, since copy + geopolitics are disabled today). When copy is brought
 * back via Branch 3, set env vars (e.g. SIGNAL_CAPITAL=4000 COPY_CAPITAL=2000
 * GEOPOLITICS_CAPITAL=300) to rebalance.
 */
const DEFAULT_PIPELINE_SHARE: Record<PipelineId, number> = {
  signal: 1.0,
  copy: 0,
  geopolitics: 0,
};

/**
 * Build per-pipeline config. Each pipeline can be configured via env:
 *   <PIPELINE>_CAPITAL  (USDC, default = totalCapital * defaultShare)
 *   <PIPELINE>_RISK_LEVEL  (default = global risk level)
 *   <PIPELINE>_ENABLED  (default 'true' for signal, 'false' for copy + geopolitics
 *                        until Branch 3 lands — keeps current behaviour)
 */
function buildPipelineConfigs(totalCapital: number, defaultRiskLevel: RiskLevel): Record<PipelineId, PipelineConfig> {
  const out = {} as Record<PipelineId, PipelineConfig>;
  for (const id of ALL_PIPELINES) {
    const upper = id.toUpperCase();
    const envCapital = process.env[`${upper}_CAPITAL`];
    const envRisk = process.env[`${upper}_RISK_LEVEL`] as RiskLevel | undefined;
    const envEnabled = process.env[`${upper}_ENABLED`];

    const defaultCapital = totalCapital * DEFAULT_PIPELINE_SHARE[id];
    const capital = envCapital ? parseFloat(envCapital) : defaultCapital;

    const riskLevel: RiskLevel = envRisk && RISK_PRESETS[envRisk] ? envRisk : defaultRiskLevel;

    // Default-enabled state matches current bot reality:
    // - signal: ON (the live pipeline today)
    // - copy: OFF (disabled since 2026-04-27 Phase 3, awaiting Branch 3 revival)
    // - geopolitics: OFF (Branch 3, not yet built)
    const defaultEnabled = id === 'signal';
    const enabled = envEnabled ? envEnabled === 'true' : defaultEnabled;

    out[id] = { id, capital, riskLevel, enabled };
  }
  return out;
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

  // Allow env override for max open positions
  const maxOpenOverride = process.env.MAX_OPEN_POSITIONS;
  if (maxOpenOverride) {
    risk.maxOpenPositions = parseInt(maxOpenOverride);
    logger.info(`MAX_OPEN_POSITIONS overridden to ${risk.maxOpenPositions} from env`);
  }

  const totalCapitalUsdc = parseFloat(envOpt('TOTAL_CAPITAL_USDC', '6300'));
  const pipelines = buildPipelineConfigs(totalCapitalUsdc, riskLevel);

  // Sanity check: pipeline allocations should not exceed total capital
  const allocatedSum = Object.values(pipelines).reduce((s, p) => s + p.capital, 0);
  if (allocatedSum > totalCapitalUsdc * 1.0001) {  // small epsilon for FP
    logger.warn(`Pipeline capital allocations sum to $${allocatedSum.toFixed(2)} > total $${totalCapitalUsdc.toFixed(2)}. Capital pools overlap on the actual cash ledger.`);
  }

  const config: AppConfig = {
    paperMode,
    risk,
    totalCapitalUsdc,
    pipelines,
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
    pipelines: Object.fromEntries(
      Object.entries(config.pipelines).map(([id, p]) => [id, `${p.enabled ? 'ON' : 'off'} $${p.capital.toFixed(0)}/${p.riskLevel}`]),
    ),
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
