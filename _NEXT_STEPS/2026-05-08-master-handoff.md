# PATS-Copy — 2026-05-08 master handoff

End-of-session checkpoint after Branch 1 SHIPPED + Branch 2 RECON-ONLY (paused after CTDD invalidated the reference architecture).

---

## TL;DR for next session

1. **Branch 1 IS LIVE** — paper-engine latency-aware pricing deployed to Hetzner at HEAD `3c4cc3c`, 10-min post-deploy verification all green.
2. **Branch 2 IS PAUSED** — original 4-6h plan died at the CTDD gate. The POC's reference (martkir/poly-trade-scan) had wrong contract addresses, wrong selectors, and a wrong Order struct ABI — Polymarket has redeployed since martkir's last commit (2026-02-12). Real production contract is `0xE111180000d2663C0091e4f400237545B87B996B` (unverified, unpublished). Realistic re-estimate: **8-15 hours dedicated session**.
3. **Branch 3 IS UNBLOCKED** — restructured to no longer depend on Branch 2 infra. Sits on EXISTING REST WalletMonitor. ~30 min.
4. **First call to make next session:** ship Branch 3 (Branch 2 will still be paused but clean) OR commit to the 8-15h Branch 2 reverse-engineering session.
5. **Open position to verify:** `35be6215` US-Iran peace SELL — RIDE-IT decision logged 2026-05-08; should auto-close end of day UTC 2026-05-08 via lifecycle manager. Either ~$75 win (~93% probable) or ~$1,084 loss. Check first.

---

## Current branch + repo state (commit before reading further if anything's loose)

```
Mac:    feat/polygon-block-wallet-monitor (branched off strategy/buy-optimization)
GitHub: same branch, pushed
Hetzner: strategy/buy-optimization at 3c4cc3c (Branch 1 merge commit)
```

**Branches alive:**
- `strategy/buy-optimization` — running on bot. Has Branch 1 merged.
- `feat/poc-polygon-ws-monitor` — POC archived as reference; constants documented in commit message; do NOT merge.
- `feat/polygon-block-wallet-monitor` — Branch 2 working branch with `ethers@^6` installed + recon notes. NOT merged. Continue here next session.
- `fix/paper-engine-latency-aware-pricing` — already merged via `3c4cc3c`; safe to delete after observation window.

---

## Branch 2 — what we know now (CTDD-verified reality)

The reference plan said: subscribe to Polygon `newHeads`, fetch each block, filter `tx.to ∈ {CTF Exchange, NegRisk CTF, NegRisk Op}` + selector `0x2287e350`, ABI-decode the 4-arg matchOrders with 13-field Order struct. **Every part of that is wrong.**

### Verified correct values

| Field | Value | How verified |
|---|---|---|
| Real trade contract | `0xE111180000d2663C0091e4f400237545B87B996B` | Traced one real trade by watched wallet |
| Real selector | `0x3c2b4399` | Same trace + 4byte directory cross-ref |
| Real Order struct | `(uint256,address,address,uint256,uint256,uint256,uint8,uint8,uint256,bytes32,bytes32,bytes)` — **12 fields, double-bytes32** | Computed selector matches `0x3c2b4399` |
| Full matchOrders sig | `matchOrders(bytes32,Order,Order[],uint256,uint256[],uint256,uint256[])` | ethers Interface roundtrip → selector matches |

### Verified WRONG values (do not use)

| Per POC reference | Actual reality |
|---|---|
| `0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e` (CTF Exchange) | Has zero trades. Only `registerToken` calls (selector `0x68c7450f`). Polymarket repurposed this address. |
| `0x2287e350` selector | Decodes to a different 7-arg matchOrders variant; not what production uses. |
| MIT 13-field Order struct | Production uses 12-field with double-bytes32 instead of single bytes signature. Different generation. |

### Test transaction for ABI inference (PRESERVE THIS)

- **txHash:** `0xda0cc9a69a86c60f4cc82b9be586b910419a74dbfef4ae1c78250d903a749085`
- **block:** 86566942
- **trade:** BUY 376.02 size at price 0.17 on slug `wta-gibson-shnaide-2026-05-07`
- **conditionId:** `0xf30520eba63519f7f6f63b9de643d4ef8bac865e310e15d8e673448d56f17003`
- **proxyWallet (from data-api):** `0x204f72f35326db932158cba6adff0b9a1da95e14`
- **on-chain `from`:** `0xF9DEA1f827EaB834F676d64f83328b5C8c8a0703` (this is a Safe operator, NOT the proxyWallet — important: maker/signer ≠ proxyWallet directly)
- **Why this matters:** the data-api proxyWallet won't appear directly in the tx `from`. It's likely embedded in one of the Order tuple's address fields (maker or signer). Cross-validating against the known data-api fields for THIS trade is how we map fields.

### Working RPC (free)

- ✅ `https://polygon-bor-rpc.publicnode.com` — works
- ❌ polygon-rpc.com — rate-limited (401)
- ❌ polygon.llamarpc.com — DNS not resolving today
- ❌ rpc.ankr.com/polygon — request hangs
- ❌ polygon.blockpi.network — 521

For production we'll need 2-3 working RPCs with failover. Re-test all candidates at session start; the working set may have rotated.

### Why the contract is hard to reverse-engineer

- 42KB of bytecode at `0xE111180000d2663C0091e4f400237545B87B996B`
- NOT verified on Sourcify (chain 137)
- NOT in any of Polymarket's open-source repos
- NOT in any GitHub code globally (search returned 0 hits)
- NOT a proxy (EIP-1967 implementation slot is empty — can't follow to source)
- We must reverse-engineer field meanings from observed traffic + data-api cross-validation

---

## Path forward for Branch 2 (next session)

```
Phase 1 — ABI inference (1-2h)
  Fetch the test tx (txHash above)
  Decode with the 7-arg signature using ethers Interface.parseTransaction
  Print every field
  Cross-reference against data-api fields for the same trade:
    proxyWallet 0x204f72f3... → which Order address field?
    BUY → which uint8 enum value? (0 or 1)
    size 376.02 → makerAmount or takerAmount, and what's the decimal scaling?
    price 0.17 → derived from makerAmount/takerAmount ratio?
    conditionId 0xf30520... → which bytes32?
    tokenId → which uint256?

Phase 2 — Decoder module (1-2h)
  src/monitor/match-orders-decoder.ts
  Pure function: tx → ParsedTrades[] (or null if not matchOrders)
  Schema: { wallet, side, size, price, tokenId, conditionId, txHash, blockNumber, timestamp }
  Golden-vector test using the test tx — must produce exactly the data-api values.

Phase 3 — WS listener (2-3h)
  src/monitor/polygon-block-listener.ts
  ethers WebSocketProvider with auto-reconnect
  Multi-RPC failover (2-3 endpoints)
  Subscribe to newHeads
  For each new block: fetch with getBlock(num, true), filter txs to target contract, run decoder
  Filter decoded trades by watched-wallet list
  Emit events compatible with existing WalletMonitor EventEmitter API

Phase 4 — Shadow integration (1-2h)
  Wire into runner.ts in parallel with existing REST WalletMonitor
  Log detected events to a separate channel (don't drive trades yet)
  Add divergence logger: trade detected by WS but not REST (or vice versa) → log

Phase 5 — Watchdog rules (1-2h)
  ws-connection-health (alert if WS drops for >5 min)
  block-detection-cadence (alert if no blocks received for >10s — Polygon block time is 2s)
  ws-vs-rest-divergence (alert if WS misses trades REST catches, or vice versa, > 5%)
  latency-observed-drift (track median WS-to-REST detection delta)
  geopolitics-cumulative-pnl (forward-looking — for Branch 3)

Phase 6 — 24-48h shadow validation (passive)
  Bot runs both monitors in parallel
  Daily WS-vs-REST divergence report
  Decision criteria: WS recall ≥ 95% AND median detection latency < 5s → promote WS to primary, demote REST to backup

TOTAL: 8-13h, plus 24-48h passive shadow window. Allow 15h budget for unknowns.
```

---

## Branch 3 — restructured during Branch 2 pause

Branch 3 originally depended on Branch 2's WS infrastructure for fast geopolitics signal capture. Restructured during this pause to sit ON THE EXISTING REST WalletMonitor — Branch 2 not required.

```
src/execution/copy-executor.ts:
  Add filter: if !COPY_GEOPOLITICS_ENABLED → only allow non-geopolitics
  Add filter: if leaderWallet ∈ COPY_GEOPOLITICS_WALLETS → allow geopolitics SELL/BUY (gated)

.env.example:
  COPY_GEOPOLITICS_ENABLED=false
  COPY_GEOPOLITICS_WALLETS=0x204f72f3...,0x2005d16a...,0xee613b3f...,...  # 12 wallets

Wallets list (from convergence backtest):
  0x204f72f35326db932158cba6adff0b9a1da95e14  211 historical trades
  0x2005d16a84ceefa912d4e380cd32e7ff827875ea  92
  0xee613b3fc183ee44f9da9c05f53e2da107e3debf  34
  0x2a2C53bD278c04DA9962Fcf96490E17F3DfB9Bc1  28
  0x5d05b1f588780423488a09d9aefeb64df54d6320  19
  0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e  12
  0x507e52ef684ca2dd91f90a9d26d149dd3288beae  7
  0x37c1874a60d348903594a96703e0507c518fc53a  6
  0x492442EaB586F242B53bDa933fD5dE859c8A3782  6
  0xfe787d2da716d60e8acff57fb87eb13cd4d10319  5
  0x0c154c190E293B7e5F8D453b5F690C4dC9599A45  2
```

Actual estimate now ~30-45 min (was ~30 min). Trivial.

---

## What's running RIGHT NOW (snapshot 2026-05-08 ~09:00 UTC)

- **Bot:** online on `strategy/buy-optimization` HEAD `3c4cc3c`. 6 pm2 processes green (polymarket-bot, polymarket-dashboard, mirofish-scanner, mirofish-bridge, pats-monitor, pm2-logrotate).
- **Branch 1 fix signature:** `PaperTradingEngine: MarketCache wired — latency-aware pricing active` confirmed in startup logs.
- **Open positions (2):**
  - `35be6215` US-Iran peace SELL — entry $0.0647, $75 size, max-loss $1,084 (20.24% of balance), resolves end of day UTC 2026-05-08, RIDE-IT decision logged. **CHECK FIRST NEXT SESSION.**
  - `bb60697f` Bitcoin $78k SELL — entry $0.9255, $75 size, opened 05:00:51 UTC.
- **Watchdog (Mac launchd):** every 30 min in `--soak` mode. Has fired 9 times today flagging `35be6215`. audit.log at `~/claude-hq/watchdogs/pats/audit.log`.
- **AI failure rate:** 8.5% (30 of 351 events). Under 20% anomaly threshold but mild uptick last hour.
- **Heartbeats:** pats-monitor on Hetzner running 30h, logging `Health: balance=$5358 WR=28.3% signals=0 positions=2` every ~5 min. Telegram routes via this monitor.

---

## Trust Gate notes (relevant for next session)

- `ethers-io` and `Polymarket` added to allowlist (`~/claude-hq/scripts/lib/advisory-check.sh`) — git clones from these orgs auto-pass Layer 0.5
- For BARE npm packages (e.g. `npm install ethers@^6`), the allowlist doesn't help because Trust Gate can't extract owner from the install string. Used `HQ_TRUST_OVERRIDE=1` once today after manual due diligence (MIT, ricmoo/ethers-io, 333 versions, 8k stars).
- BACKLOG entry queued: `~/claude-hq/docs/BACKLOG.md` — "Trust Gate: npm-registry-aware author resolution for bare packages". 1-2h enhancement.

---

## Files modified today (and committed)

### PATS-Copy (`~/Desktop/POLYMARKET_TRADING_3.0`)
- `src/core/paper-trading.ts` — Branch 1 (latency-aware pricing). Committed as `64dd152`, merged as `3c4cc3c`.
- `src/core/runner.ts` — Branch 1 wiring. Same commit.
- `package.json` + `package-lock.json` — `ethers@^6.16.0` added on `feat/polygon-block-wallet-monitor`.
- `_NEXT_STEPS/2026-05-08-master-handoff.md` — this file.
- `scripts/poc/polygon-ws-monitor.py` — POC archived on `feat/poc-polygon-ws-monitor` (separate branch, not merged).

### claude-hq (`~/claude-hq`)
- `scripts/lib/advisory-check.sh` — added `ethers-io` and `Polymarket` to allowlist.
- `docs/BACKLOG.md` — added "Trust Gate: npm-registry-aware author resolution for bare packages" entry.

### Vault (`~/Vaults/Jarvis-Brain`)
- `JARVIS-BRAIN/Projects/PATS-Copy/00 PATS-Copy Hub.md` — Current State updated with Branch 1 done + Branch 2 paused.
- `JARVIS-BRAIN/Projects/PATS-Copy/04 Decision Log.md` — three new entries: Branch 1 ship, RIDE-IT for `35be6215`, Branch 2 PAUSED with full CTDD evidence.

---

## On session resume

```bash
# 1. Recommended cwd
cd ~/Desktop/POLYMARKET_TRADING_3.0
git branch --show-current  # should be: feat/polygon-block-wallet-monitor

# 2. Verify nothing drifted overnight
ssh root@204.168.204.247 'cd /opt/polymarket-bot && git log --oneline -1 && pm2 jlist | python3 -c "import json,sys,time; d=json.load(sys.stdin); b=[p for p in d if p[\"name\"]==\"polymarket-bot\"][0]; print(f\"status={b[\"pm2_env\"][\"status\"]} restarts={b[\"pm2_env\"][\"restart_time\"]} uptime_s={(time.time()*1000-b[\"pm2_env\"][\"pm_uptime\"])/1000:.0f}\")"'

# 3. Check 35be6215 — did it close as expected?
ssh root@204.168.204.247 'cd /opt/polymarket-bot && pm2 logs polymarket-bot --nostream --lines 5000 2>&1 | grep -E "35be6215|us-x-iran-permanent-peace" | tail -10'

# 4. Read this file + Decision Log + Hub before deciding Branch 2 vs Branch 3
cat ~/Desktop/POLYMARKET_TRADING_3.0/_NEXT_STEPS/2026-05-08-master-handoff.md
cat "~/Vaults/Jarvis-Brain/JARVIS-BRAIN/Projects/PATS-Copy/04 Decision Log.md" | head -60
```
