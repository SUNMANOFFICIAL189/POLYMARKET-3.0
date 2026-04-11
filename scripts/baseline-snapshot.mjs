#!/usr/bin/env node
// Baseline snapshot script — T0.3
//
// Read-only. Queries Supabase directly, computes the same metrics the
// fixed dashboard deriveMetrics() function produces, and writes a
// baseline markdown report that future optimisation tiers will be
// measured against.
//
// Usage:
//   node scripts/baseline-snapshot.mjs
// Or from any dir:
//   node /abs/path/to/scripts/baseline-snapshot.mjs

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Parse .env manually — keeps the script dependency-free beyond @supabase/supabase-js.
const env = Object.fromEntries(
  readFileSync(resolve(ROOT, '.env'), 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    })
)

const url = env.SUPABASE_URL
const key = env.SUPABASE_SERVICE_KEY
if (!url || !key) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env')
  process.exit(1)
}

const supabase = createClient(url, key)
const DEPOSIT = 6300

console.log('Querying copy_trades…')
const { data: trades, error } = await supabase
  .from('copy_trades')
  .select('*')
  .order('entry_time', { ascending: false })
  .limit(5000)

if (error) {
  console.error('Supabase error:', error.message)
  process.exit(1)
}

console.log(`Fetched ${trades.length} trades.\n`)

// ─── Status breakdown ─────────────────────────────────────────────
const byStatus = trades.reduce((acc, t) => {
  acc[t.status] = (acc[t.status] ?? 0) + 1
  return acc
}, {})

// ─── Null-pnl audit (for T0.2) ────────────────────────────────────
const closedOrStopped = trades.filter(t => t.status === 'closed' || t.status === 'stopped')
const closedNullPnl = closedOrStopped.filter(t => t.pnl == null)
const closedWithPnl = closedOrStopped.filter(t => t.pnl != null)

// ─── Metrics (same logic as the new dashboard deriveMetrics) ──────
const decidedTrades = closedWithPnl
  .filter(t => t.exit_time != null)
  .sort((a, b) => (a.exit_time ?? '').localeCompare(b.exit_time ?? ''))

const realizedPnl = decidedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
const reservedCapital = trades
  .filter(t => t.status === 'open' || t.status === 'pending')
  .reduce((s, t) => s + (t.our_size ?? 0), 0)
const balance = DEPOSIT - reservedCapital + realizedPnl
const totalReturnUsd = balance - DEPOSIT
const totalReturnPct = ((balance - DEPOSIT) / DEPOSIT) * 100

const wins = decidedTrades.filter(t => (t.pnl ?? 0) > 0).length
const losses = decidedTrades.filter(t => (t.pnl ?? 0) < 0).length
const decidedCount = wins + losses
const winRate = decidedCount > 0 ? wins / decidedCount : null
const avgReturn = decidedTrades.length > 0 ? realizedPnl / decidedTrades.length : null

// Max drawdown walk
let runningBalance = DEPOSIT
let peakBalance = DEPOSIT
let maxDrawdownPct = 0
for (const t of decidedTrades) {
  runningBalance += t.pnl ?? 0
  if (runningBalance > peakBalance) peakBalance = runningBalance
  const dd = peakBalance > 0 ? (peakBalance - runningBalance) / peakBalance : 0
  if (dd > maxDrawdownPct) maxDrawdownPct = dd
}
const maxDrawdown = decidedTrades.length > 0 ? maxDrawdownPct * 100 : null

// Simple Sharpe
const perTradeReturns = decidedTrades
  .filter(t => (t.our_size ?? 0) > 0)
  .map(t => (t.pnl ?? 0) / (t.our_size ?? 1))
let sharpe = null
if (perTradeReturns.length >= 2) {
  const mean = perTradeReturns.reduce((s, r) => s + r, 0) / perTradeReturns.length
  const variance = perTradeReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (perTradeReturns.length - 1)
  const stdev = Math.sqrt(variance)
  if (stdev > 0) sharpe = mean / stdev
}

// ─── Biggest winners / losers ─────────────────────────────────────
const sortedByPnl = [...decidedTrades].sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0))
const worst5 = sortedByPnl.slice(0, 5)
const best5 = sortedByPnl.slice(-5).reverse()

// ─── MiroFish override count ──────────────────────────────────────
const mirofishOverrides = trades.filter(t =>
  (t.confirmation_reason ?? '').includes('MiroFish contradicts') &&
  (t.confirmation_reason ?? '').includes('proceeding with leader')
)
const mirofishOverrideWins = mirofishOverrides
  .filter(t => (t.status === 'closed' || t.status === 'stopped') && (t.pnl ?? 0) > 0).length
const mirofishOverrideLosses = mirofishOverrides
  .filter(t => (t.status === 'closed' || t.status === 'stopped') && (t.pnl ?? 0) < 0).length

// ─── Win/loss breakdown by wallet ─────────────────────────────────
const byWallet = {}
for (const t of decidedTrades) {
  const w = t.leader_wallet ?? 'unknown'
  if (!byWallet[w]) byWallet[w] = { wins: 0, losses: 0, pnl: 0 }
  if ((t.pnl ?? 0) > 0) byWallet[w].wins++
  else if ((t.pnl ?? 0) < 0) byWallet[w].losses++
  byWallet[w].pnl += t.pnl ?? 0
}
const walletRows = Object.entries(byWallet)
  .map(([wallet, s]) => ({
    wallet: wallet.slice(0, 6) + '…' + wallet.slice(-4),
    decided: s.wins + s.losses,
    wr: s.wins + s.losses > 0 ? (100 * s.wins / (s.wins + s.losses)).toFixed(1) + '%' : '—',
    pnl: '$' + s.pnl.toFixed(2),
  }))
  .sort((a, b) => parseFloat(b.pnl.replace(/[\$,]/g, '')) - parseFloat(a.pnl.replace(/[\$,]/g, '')))

// ─── Date range ───────────────────────────────────────────────────
const entryDates = trades.map(t => t.entry_time).filter(Boolean).sort()
const firstEntry = entryDates[0] ?? 'n/a'
const lastEntry = entryDates[entryDates.length - 1] ?? 'n/a'

// ─── Output console summary ───────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════')
console.log('BASELINE SNAPSHOT — 2026-04-12')
console.log('═══════════════════════════════════════════════════════════')
console.log(`Total trades in DB:     ${trades.length}`)
console.log(`Window:                 ${firstEntry}  →  ${lastEntry}`)
console.log()
console.log('Status breakdown:')
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${v}`)
}
console.log()
console.log(`Closed/stopped WITH pnl:  ${closedWithPnl.length}`)
console.log(`Closed/stopped NULL pnl:  ${closedNullPnl.length}  ${closedNullPnl.length > 0 ? '⚠ BACKFILL NEEDED' : '✓'}`)
console.log()
console.log(`Balance:        $${balance.toFixed(2)}`)
console.log(`Realized PnL:   $${realizedPnl.toFixed(2)} (${totalReturnPct.toFixed(2)}%)`)
console.log(`Win Rate:       ${winRate !== null ? (winRate * 100).toFixed(1) + '%' : '—'}  (${wins}W / ${losses}L)`)
console.log(`Avg PnL/trade:  ${avgReturn !== null ? '$' + avgReturn.toFixed(2) : '—'}`)
console.log(`Max Drawdown:   ${maxDrawdown !== null ? maxDrawdown.toFixed(2) + '%' : '—'}`)
console.log(`Sharpe (simple):${sharpe !== null ? ' ' + sharpe.toFixed(3) : ' —'}`)
console.log()
console.log(`MiroFish overrides:        ${mirofishOverrides.length}`)
console.log(`  decided outcomes:        ${mirofishOverrideWins}W / ${mirofishOverrideLosses}L`)
console.log('═══════════════════════════════════════════════════════════')

// ─── Write markdown baseline report ───────────────────────────────
const md = `# PATS-Copy Baseline Snapshot
**Generated:** ${new Date().toISOString()}
**Branch at snapshot:** optimization/2026-04-12-strategy-fixes
**Deposit assumed:** $${DEPOSIT.toLocaleString()}
**Source:** direct Supabase query via \`scripts/baseline-snapshot.mjs\`

This document is the **control condition** against which all Tier 1+ strategy fixes are measured. Do not overwrite without archiving.

---

## Headline Metrics

| Metric | Value |
|---|---|
| **Balance** | $${balance.toFixed(2)} |
| **Realised PnL** | $${realizedPnl.toFixed(2)} (${totalReturnPct >= 0 ? '+' : ''}${totalReturnPct.toFixed(2)}%) |
| **Win Rate** | ${winRate !== null ? (winRate * 100).toFixed(1) + '%' : '—'} (${wins}W / ${losses}L from ${decidedCount} decided) |
| **Avg PnL / trade** | ${avgReturn !== null ? '$' + avgReturn.toFixed(2) : '—'} |
| **Max Drawdown** | ${maxDrawdown !== null ? maxDrawdown.toFixed(2) + '%' : '—'} |
| **Sharpe (simple, per-trade)** | ${sharpe !== null ? sharpe.toFixed(3) : '—'} |
| **Target WR** | 65% |
| **Target monthly return** | +8% |
| **Target max DD** | <15% |

## Data Integrity

| Check | Value |
|---|---|
| Total trades in \`copy_trades\` | ${trades.length} |
| Window (entry_time) | ${firstEntry} → ${lastEntry} |
| Closed/stopped with valid pnl | ${closedWithPnl.length} |
| Closed/stopped with NULL pnl | ${closedNullPnl.length} ${closedNullPnl.length > 0 ? '⚠ needs backfill' : '✓'} |

## Status Breakdown

| Status | Count |
|---|---|
${Object.entries(byStatus).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`).join('\n')}

## Confirmation Layer Observability

| Signal | Count |
|---|---|
| MiroFish overrides (contradiction → proceeded) | ${mirofishOverrides.length} |
| …of which decided: Wins | ${mirofishOverrideWins} |
| …of which decided: Losses | ${mirofishOverrideLosses} |
| Override loss ratio (losses / decided) | ${mirofishOverrideWins + mirofishOverrideLosses > 0 ? (100 * mirofishOverrideLosses / (mirofishOverrideWins + mirofishOverrideLosses)).toFixed(1) + '%' : '—'} |

**Interpretation:** the MiroFish override count measures devil's-advocate toothlessness. In a bot where MiroFish has a real veto, this number should be zero or near-zero. High loss ratio → the override is costing real money and finding 3.3 in the strategic analysis is observationally confirmed.

## Performance by Leader Wallet (decided trades only)

| Wallet | Decided | WR | PnL |
|---|---|---|---|
${walletRows.slice(0, 15).map(r => `| ${r.wallet} | ${r.decided} | ${r.wr} | ${r.pnl} |`).join('\n')}

## 5 Worst Trades (by PnL)

| Market | Outcome | PnL | Status |
|---|---|---|---|
${worst5.map(t => `| ${(t.market_question ?? '').slice(0, 60)}… | ${t.outcome ?? '—'} | $${(t.pnl ?? 0).toFixed(2)} | ${t.status} |`).join('\n')}

## 5 Best Trades (by PnL)

| Market | Outcome | PnL | Status |
|---|---|---|---|
${best5.map(t => `| ${(t.market_question ?? '').slice(0, 60)}… | ${t.outcome ?? '—'} | $${(t.pnl ?? 0).toFixed(2)} | ${t.status} |`).join('\n')}

---

*This is an auto-generated, read-only baseline. To regenerate: \`node scripts/baseline-snapshot.mjs\`.*
`

const outPath = resolve(ROOT, 'docs/BASELINE_2026-04-12.md')
writeFileSync(outPath, md)
console.log()
console.log(`✓ Baseline written to: ${outPath}`)

if (closedNullPnl.length > 0) {
  console.log()
  console.log(`⚠ ${closedNullPnl.length} closed/stopped trades have NULL pnl.`)
  console.log('  These need backfilling. Sample row:')
  console.log(`  ${JSON.stringify(closedNullPnl[0], null, 2).split('\n').slice(0, 15).join('\n  ')}`)
  process.exit(0)
}
