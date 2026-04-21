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
  const { error } = await getClient().from('leaders').upsert({
    wallet_address: leader.walletAddress.toLowerCase(),
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

export async function upsertLeaders(leaders: Leader[]): Promise<void> {
  for (const leader of leaders) {
    await upsertLeader(leader);
  }
}

export async function setCurrentLeader(walletAddress: string): Promise<void> {
  // Clear all current leaders first
  await getClient().from('leaders').update({ is_current_leader: false }).neq('wallet_address', '');

  // Set new current leader (normalise to lowercase to match upsert key)
  const { error } = await getClient().from('leaders')
    .update({ is_current_leader: true })
    .eq('wallet_address', walletAddress.toLowerCase());
  if (error) logger.error(`setCurrentLeader failed: ${error.message}`);
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
    trades_vetoed: perf.tradesVetoed,
    wins: perf.wins,
    losses: perf.losses,
    win_rate: perf.winRate,
    max_drawdown: perf.maxDrawdown,
    exposure: perf.exposure,
    risk_level: perf.riskLevel,
    leader_wallet: perf.leaderWallet,
    leader_name: perf.leaderName,
    balance_usdc: perf.balance,
  }, { onConflict: 'date' });
  if (error) logger.error(`upsertDailyPerformance failed: ${error.message}`);
}

export async function updateBotBalance(balance: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  const { error } = await getClient().from('daily_performance').upsert({
    date: today,
    balance_usdc: balance,
  }, { onConflict: 'date' });
  if (error) logger.error(`updateBotBalance failed: ${error.message}`);
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
  return {
    id: row.id as string,
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
