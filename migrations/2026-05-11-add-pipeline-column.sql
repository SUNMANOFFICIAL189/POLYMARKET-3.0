-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `pipeline` column to copy_trades + backfill from leader_wallet
--
-- Date    : 2026-05-11
-- Purpose : Option D refactor — explicit per-pipeline tagging on every trade,
--           replacing the brittle leader_wallet === 'signal-bot' string match.
-- Author  : Option D pipeline-isolation work (feat/option-d-pipeline-isolation)
-- Run by  : User (manually via Supabase Dashboard → SQL Editor)
-- Pre-req : NONE (idempotent — safe to run multiple times)
-- Side fx : Adds 1 column. Updates ~720 historical rows. Adds 1 index.
--           No locks beyond brief row-level locks during UPDATE. Reads are
--           uninterrupted at READ COMMITTED isolation level.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Add the column (nullable, so concurrent INSERTs that don't yet include
--    pipeline don't fail). The Option D code deploy will start writing this
--    column on every new insert.
ALTER TABLE copy_trades
  ADD COLUMN IF NOT EXISTS pipeline TEXT;

-- 2. Backfill historical rows. Uses the same derivation the runner has been
--    using to split signal vs copy on hydration (leader_wallet === 'signal-bot'
--    string match). After this UPDATE, every existing row has a pipeline.
UPDATE copy_trades
SET    pipeline = CASE
         WHEN leader_wallet = 'signal-bot' THEN 'signal'
         ELSE 'copy'
       END
WHERE  pipeline IS NULL;

-- 3. Index for per-pipeline queries (per-pipeline P&L, per-pipeline open count,
--    watchdog rules that group by pipeline). Cheap to maintain at our row count.
CREATE INDEX IF NOT EXISTS idx_copy_trades_pipeline ON copy_trades(pipeline);

-- 4. Optional follow-up after deploy stabilises (don't run yet — wait until
--    all new inserts are confirmed populating `pipeline`, then enforce NOT
--    NULL to catch any future code path that forgets to include it):
--
--   ALTER TABLE copy_trades ALTER COLUMN pipeline SET NOT NULL;

-- ─── Verification queries ───────────────────────────────────────────────
-- Run these AFTER the migration to confirm correctness:
--
-- 1) No NULL pipelines among existing rows:
--      SELECT COUNT(*) FROM copy_trades WHERE pipeline IS NULL;
--      Expected: 0
--
-- 2) Counts per pipeline:
--      SELECT pipeline, COUNT(*) AS trades, SUM(pnl)::numeric(12,2) AS total_pnl
--      FROM copy_trades GROUP BY pipeline ORDER BY pipeline;
--
-- 3) After deploy completes, fresh inserts should have pipeline set:
--      SELECT pipeline, COUNT(*) FROM copy_trades
--      WHERE entry_time > NOW() - INTERVAL '10 minutes' GROUP BY pipeline;
