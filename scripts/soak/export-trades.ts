#!/usr/bin/env tsx
/**
 * Dump copy_trades from Supabase to soak-export.json for the clean-data soak.
 * READ-ONLY (a plain select, same as the bot does constantly).
 *
 * Run on the server (where .env has the Supabase creds):
 *     cd /opt/polymarket-bot && npx tsx scripts/soak/export-trades.ts
 * Then score it:
 *     python3 scripts/soak/checkpoint.py soak-export.json
 *
 * Spec: _NEXT_STEPS/clean-data-soak-2026-06-28.md
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { initSupabase, getClient } from '../../src/data/supabase.js';

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_KEY ?? '';
  if (!url || !key) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY — run on the server where .env is present.');
    process.exit(1);
  }
  initSupabase(url, key);

  const PAGE = 1000; // Supabase caps a select at 1000 rows — paginate.
  const all: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getClient()
      .from('copy_trades')
      .select('*')
      .order('entry_time', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Supabase error:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
  }

  writeFileSync('soak-export.json', JSON.stringify(all));
  console.log(`exported ${all.length} copy_trades → soak-export.json`);
}

void main();
