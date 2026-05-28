import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import type { CopyTrade, Leader, DailyPerformance, RiskLevel } from '../types/index.js';
import type { RotationEvent } from '../leaderboard/selector.js';

let client: SupabaseClient;

export function initSupabase(url: string, key: string): SupabaseClient {
  client = createClient(url, key);
  logger.info('Supabase client initialized');
  // Probe schema immediately so missing tables surface at boot, not on first trade
  client.from('leaders').select('wallet_address').limit(1).then(({ error }) => {
    if (error) logger.error(`Supabase: schema check FAILED — ${error.message}`);
    else logger.info('Supabase: schema OK — leaders table confirmed');
  });
  return client;
}

export function getClient(): SupabaseClient {
  if (!client) throw new Error('Supabase not initialized');
  return client;
}

// ─── Leader Operations ─────────────────────────────────────────

export async function upsertLeader(leader: Leader): Promise<void> {
  // Skip-if-unchanged: pull existing row first, compare meaningful fields,
  // only write if at least one differs. Called on every leaderboard poll
  // for every leader (~20 rows × 12 polls/hour = ~5,800/day baseline).
  // Most polls produce no logical change for most leaders; the upsert
  // contributed substantial write IO before this check (2026-05-08 audit).
  const target = leader.walletAddress.toLowerCase();
  const { data: existing } = await getClient()
    .from('leaders')
    .select('display_name, composite_score, win_rate_30d, profit_factor_14d, trade_count_30d, total_pnl_30d, last_trade_time, tracked_since')
    .eq('wallet_address', target)
    .maybeSingle();

  if (existing) {
    const ex: any = existing;
    const samePayload =
      ex.display_name === leader.displayName &&
      ex.composite_score === leader.compositeScore &&
      ex.win_rate_30d === leader.winRate30d &&
      ex.profit_factor_14d === leader.profitFactor14d &&
      ex.trade_count_30d === leader.tradeCount30d &&
      ex.total_pnl_30d === leader.totalPnl30d &&
      ex.last_trade_time === leader.lastTradeTime &&
      ex.tracked_since === leader.trackedSince;
    if (samePayload) return; // no-op: avoid the write + WAL + autovacuum churn
  }

  const { error } = await getClient().from('leaders').upsert({
    wallet_address: target,
    display_name: leader.displayName,
    composite_score: leader.compositeScore,
    win_rate_30d: leader.winRate30d,
    profit_factor_14d: leader.profitFactor14d,
    trade_count_30d: leader.tradeCount30d,
    total_pnl_30d: leader.totalPnl30d,
    last_trade_time: leader.lastTradeTime,
    // is_current_leader removed — managed exclusively by setCurrentLeader()
    tracked_since: leader.trackedSince,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'wallet_address' });
  if (error) logger.error(`upsertLeader failed: ${error.message}`);
}

/**
 * Existing-row shape used by diffLeaders to detect "no-op" upserts.
 * Mirrors the SELECT projection inside upsertLeaders.
 */
export interface ExistingLeaderRow {
  wallet_address: string;
  display_name: string | null;
  composite_score: number | null;
  win_rate_30d: number | null;
  profit_factor_14d: number | null;
  trade_count_30d: number | null;
  total_pnl_30d: number | null;
  last_trade_time: string | null;
  tracked_since: string | null;
}

/**
 * Pure function: given a map of {lowercase wallet → existing row} and the
 * incoming leader batch, return ONLY the leaders whose payload differs from
 * the existing row (or whose wallet isn't in the map yet).
 *
 * Extracted from upsertLeaders so the per-row samePayload logic is testable
 * in isolation (see scripts/test-leader-diff.ts).
 *
 * Created 2026-05-28 as part of the bulk-read refactor that cuts ~95% of
 * Supabase reads (~5,760/day → ~288/day from this hot path alone).
 */
export function diffLeaders(
  existingByWallet: Map<string, ExistingLeaderRow>,
  newLeaders: Leader[],
): Leader[] {
  const result: Leader[] = [];
  for (const leader of newLeaders) {
    const target = leader.walletAddress.toLowerCase();
    const ex = existingByWallet.get(target);
    if (!ex) {
      result.push(leader);
      continue;
    }
    const samePayload =
      ex.display_name === leader.displayName &&
      ex.composite_score === leader.compositeScore &&
      ex.win_rate_30d === leader.winRate30d &&
      ex.profit_factor_14d === leader.profitFactor14d &&
      ex.trade_count_30d === leader.tradeCount30d &&
      ex.total_pnl_30d === leader.totalPnl30d &&
      ex.last_trade_time === leader.lastTradeTime &&
      ex.tracked_since === leader.trackedSince;
    if (!samePayload) result.push(leader);
  }
  return result;
}

/**
 * Bulk leader upsert with single read + single write.
 *
 * Previous implementation looped per-leader (20 SELECTs + 0-20 UPDATEs per
 * 5-min poll = ~5,760 reads/day for the leaderboard sync alone). This was
 * the dominant Supabase IO consumer found during the 2026-05-28 Disk IO
 * Budget depletion investigation. Pattern echoes the 2026-05-08 incident
 * with setCurrentLeader (see comment block above), but in a different
 * function so the prior fix didn't cover it.
 *
 * Current implementation: 1 SELECT for all wallets, diff locally, 1 bulk
 * UPSERT for only the changed rows. ~95% reduction.
 */
export async function upsertLeaders(leaders: Leader[]): Promise<void> {
  if (leaders.length === 0) return;

  const wallets = leaders.map(l => l.walletAddress.toLowerCase());

  // ONE bulk read for all wallets' existing rows
  const { data: existing, error: readErr } = await getClient()
    .from('leaders')
    .select('wallet_address, display_name, composite_score, win_rate_30d, profit_factor_14d, trade_count_30d, total_pnl_30d, last_trade_time, tracked_since')
    .in('wallet_address', wallets);
  if (readErr) {
    logger.error(`upsertLeaders bulk read failed: ${readErr.message}`);
    return;
  }

  const existingByWallet = new Map<string, ExistingLeaderRow>(
    (existing ?? []).map((e) => [e.wallet_address as string, e as ExistingLeaderRow]),
  );

  const toUpsert = diffLeaders(existingByWallet, leaders);
  if (toUpsert.length === 0) return; // no-op: nothing changed across all leaders

  const now = new Date().toISOString();
  const rows = toUpsert.map((leader) => ({
    wallet_address: leader.walletAddress.toLowerCase(),
    display_name: leader.displayName,
    composite_score: leader.compositeScore,
    win_rate_30d: leader.winRate30d,
    profit_factor_14d: leader.profitFactor14d,
    trade_count_30d: leader.tradeCount30d,
    total_pnl_30d: leader.totalPnl30d,
    last_trade_time: leader.lastTradeTime,
    tracked_since: leader.trackedSince,
    updated_at: now,
  }));

  // ONE bulk upsert for only the changed rows
  const { error } = await getClient().from('leaders').upsert(rows, { onConflict: 'wallet_address' });
  if (error) logger.error(`upsertLeaders bulk upsert failed (${rows.length} rows): ${error.message}`);
}

export async function setCurrentLeader(walletAddress: string): Promise<void> {
  // Idempotent: only write when state has actually drifted. Called on every
  // leaderboard poll (~12/hour) for drift-prevention, so the WHERE clauses
  // below are critical — without them, every poll updates ~141 rows even
  // when nothing changed (the source of the 2026-05-08 disk-IO budget alert:
  // public.leaders had 847k lifetime updates, mostly from this function
  // unconditionally clearing all rows on every call).
  const target = walletAddress.toLowerCase();

  // Clear: only rows that are currently flagged AND aren't the new target.
  // Typical no-op call: 0 rows. Typical rotation call: 1 row.
  const { error: clearErr } = await getClient().from('leaders')
    .update({ is_current_leader: false })
    .eq('is_current_leader', true)
    .neq('wallet_address', target);
  if (clearErr) logger.error(`setCurrentLeader clear failed: ${clearErr.message}`);

  // Set: only if the target row isn't already flagged.
  // Typical no-op call: 0 rows. Typical rotation call: 1 row.
  const { error: setErr } = await getClient().from('leaders')
    .update({ is_current_leader: true })
    .eq('wallet_address', target)
    .eq('is_current_leader', false);
  if (setErr) logger.error(`setCurrentLeader set failed: ${setErr.message}`);
}

export async function insertLeaderHistory(event: RotationEvent): Promise<void> {
  const { error } = await getClient().from('leader_history').insert({
    wallet_address: event.newLeader.walletAddress,
    display_name: event.newLeader.displayName,
    became_leader_at: event.timestamp,
    trades_copied: 0,
    pnl_during_tenure: 0,
  });
  if (error) logger.error(`insertLeaderHistory failed: ${error.message}`);

  // Close out previous leader's history entry
  if (event.previousLeader) {
    const { error: err2 } = await getClient().from('leader_history')
      .update({
        replaced_at: event.timestamp,
        reason_replaced: event.reason,
      })
      .eq('wallet_address', event.previousLeader.walletAddress)
      .is('replaced_at', null);
    if (err2) logger.error(`closeLeaderHistory failed: ${err2.message}`);
  }
}

// ─── Copy Trade Operations ─────────────────────────────────────

export async function insertCopyTrade(trade: CopyTrade): Promise<string | null> {
  const { data, error } = await getClient().from('copy_trades').insert({
    pipeline: trade.pipeline,  // Option D — requires `pipeline TEXT` column to exist (migration 2026-05-11)
    leader_wallet: trade.leaderWallet,
    leader_trade_id: trade.leaderTradeId,
    market_id: trade.marketId,
    market_question: trade.marketQuestion,
    token_id: trade.tokenId,
    outcome: trade.outcome,
    side: trade.side,
    leader_entry_price: trade.leaderEntryPrice,
    our_entry_price: trade.ourEntryPrice,
    our_size: trade.ourSize,
    confirmation_result: trade.confirmationResult,
    confirmation_reason: trade.confirmationReason,
    status: trade.status,
    risk_level: trade.riskLevel,
    pnl: trade.pnl,
    entry_time: trade.entryTime,
    exit_time: trade.exitTime,
    created_at: new Date().toISOString(),
  }).select('id').single();

  if (error) {
    logger.error(`insertCopyTrade failed: ${error.message}`);
    return null;
  }
  return (data as any)?.id ?? null;
}

export async function updateCopyTrade(id: string, updates: Partial<CopyTrade>): Promise<void> {
  const mapped: Record<string, unknown> = {};
  if (updates.status !== undefined) mapped.status = updates.status;
  if (updates.pnl !== undefined) mapped.pnl = updates.pnl;
  if (updates.exitTime !== undefined) mapped.exit_time = updates.exitTime;
  if (updates.ourEntryPrice !== undefined) mapped.our_entry_price = updates.ourEntryPrice;
  // exit_reason column can be added later via Supabase SQL editor if needed

  const { error } = await getClient().from('copy_trades').update(mapped).eq('id', id);
  if (error) logger.error(`updateCopyTrade failed: ${error.message}`);
}

export async function getOpenCopyTrades(): Promise<CopyTrade[]> {
  const { data, error } = await getClient()
    .from('copy_trades')
    .select('*')
    .in('status', ['pending', 'open'])
    .order('entry_time', { ascending: false });

  if (error) { logger.error(`getOpenCopyTrades failed: ${error.message}`); return []; }
  return (data ?? []).map(mapCopyTradeRow);
}

// ─── Daily Performance ─────────────────────────────────────────

export async function upsertDailyPerformance(perf: DailyPerformance): Promise<void> {
  const { error } = await getClient().from('daily_performance').upsert({
    date: perf.date,
    pnl: perf.pnl,
    pnl_pct: perf.pnlPct,
    trades_executed: perf.tradesExecuted,
    wins: perf.wins,
    losses: perf.losses,
    win_rate: perf.winRate,
    max_drawdown: perf.maxDrawdown,
    exposure: perf.exposure,
    risk_level: perf.riskLevel,
  }, { onConflict: 'date' });
  if (error) logger.error(`upsertDailyPerformance failed: ${error.message}`);
}

export async function updateBotBalance(balance: number): Promise<void> {
  // balance_usdc column doesn't exist in schema — use .bot-status.json instead
  // Kept as no-op to avoid breaking callers
}

// ─── Leader History Stats ──────────────────────────────────────

export async function incrementLeaderTrades(walletAddress: string, pnl: number): Promise<void> {
  // Update the current leader_history entry with new trade count and P&L
  const { data } = await getClient()
    .from('leader_history')
    .select('id, trades_copied, pnl_during_tenure')
    .eq('wallet_address', walletAddress)
    .is('replaced_at', null)
    .single();

  if (!data) return;

  await getClient().from('leader_history').update({
    trades_copied: (data.trades_copied || 0) + 1,
    pnl_during_tenure: (data.pnl_during_tenure || 0) + pnl,
  }).eq('id', data.id);
}

// ─── Mappers ───────────────────────────────────────────────────

function mapCopyTradeRow(row: Record<string, unknown>): CopyTrade {
  // Read `pipeline` from Supabase column if present, fall back to deriving
  // from leader_wallet (forward-compat shim until the column lands & is
  // backfilled). Option D, 2026-05-11.
  const rawPipeline = row.pipeline as string | null | undefined;
  const pipeline = (rawPipeline === 'signal' || rawPipeline === 'copy' || rawPipeline === 'geopolitics')
    ? rawPipeline
    : (row.leader_wallet === 'signal-bot' ? 'signal' : 'copy');
  return {
    id: row.id as string,
    pipeline,
    leaderWallet: row.leader_wallet as string,
    leaderTradeId: row.leader_trade_id as string | undefined,
    marketId: row.market_id as string,
    marketQuestion: row.market_question as string,
    tokenId: row.token_id as string | undefined,
    outcome: row.outcome as string,
    side: row.side as CopyTrade['side'],
    leaderEntryPrice: row.leader_entry_price as number,
    ourEntryPrice: row.our_entry_price as number | undefined,
    ourSize: row.our_size as number,
    confirmationResult: row.confirmation_result as CopyTrade['confirmationResult'],
    confirmationReason: row.confirmation_reason as string | undefined,
    status: row.status as CopyTrade['status'],
    riskLevel: row.risk_level as RiskLevel,
    pnl: row.pnl as number | undefined,
    entryTime: row.entry_time as string,
    exitTime: row.exit_time as string | undefined,
    createdAt: row.created_at as string | undefined,
  };
}
