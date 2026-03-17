# Supabase Schema for PATS-Copy

## New Tables (run in Supabase SQL Editor)

```sql
-- Leaders table: tracked traders from the leaderboard
CREATE TABLE IF NOT EXISTS leaders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  composite_score FLOAT NOT NULL DEFAULT 0,
  win_rate_30d FLOAT NOT NULL DEFAULT 0,
  profit_factor_14d FLOAT NOT NULL DEFAULT 0,
  trade_count_30d INT NOT NULL DEFAULT 0,
  total_pnl_30d FLOAT NOT NULL DEFAULT 0,
  last_trade_time TIMESTAMPTZ,
  is_current_leader BOOLEAN NOT NULL DEFAULT false,
  tracked_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leader history: who was followed when
CREATE TABLE IF NOT EXISTS leader_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  display_name TEXT,
  became_leader_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_at TIMESTAMPTZ,
  trades_copied INT NOT NULL DEFAULT 0,
  pnl_during_tenure FLOAT NOT NULL DEFAULT 0,
  reason_replaced TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Copy trades: every trade we copied (or vetoed)
CREATE TABLE IF NOT EXISTS copy_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_wallet TEXT NOT NULL,
  leader_trade_id TEXT,
  market_id TEXT NOT NULL,
  market_question TEXT NOT NULL,
  token_id TEXT,
  outcome TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  leader_entry_price FLOAT,
  our_entry_price FLOAT,
  our_size FLOAT NOT NULL,
  confirmation_result TEXT NOT NULL CHECK (confirmation_result IN ('approved', 'vetoed', 'skipped')),
  confirmation_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'open', 'closed', 'stopped', 'vetoed')),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('paper', 'conservative', 'moderate', 'aggressive')),
  pnl FLOAT,
  entry_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  exit_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily performance (reuse from pats-poly, add leader info)
CREATE TABLE IF NOT EXISTS daily_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date TEXT NOT NULL UNIQUE,
  pnl FLOAT NOT NULL DEFAULT 0,
  pnl_pct FLOAT NOT NULL DEFAULT 0,
  trades_executed INT NOT NULL DEFAULT 0,
  trades_vetoed INT NOT NULL DEFAULT 0,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  win_rate FLOAT NOT NULL DEFAULT 0,
  leader_wallet TEXT,
  leader_name TEXT,
  max_drawdown FLOAT NOT NULL DEFAULT 0,
  exposure FLOAT NOT NULL DEFAULT 0,
  risk_level TEXT NOT NULL DEFAULT 'paper',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_leaders_composite ON leaders(composite_score DESC);
CREATE INDEX IF NOT EXISTS idx_leaders_current ON leaders(is_current_leader) WHERE is_current_leader = true;
CREATE INDEX IF NOT EXISTS idx_copy_trades_leader ON copy_trades(leader_wallet);
CREATE INDEX IF NOT EXISTS idx_copy_trades_status ON copy_trades(status);
CREATE INDEX IF NOT EXISTS idx_leader_history_wallet ON leader_history(wallet_address);
```

## Existing Tables (from PATS-Poly, if migrating)

The `trades` table from pats-poly can be replaced by `copy_trades` above.
The `daily_performance` table is recreated with leader tracking fields.
