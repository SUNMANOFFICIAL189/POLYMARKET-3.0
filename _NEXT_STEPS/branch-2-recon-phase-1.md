# Branch 2 Phase 1 — Recon notes (matchOrders ABI decoded)

**Date:** 2026-05-08
**Test tx:** `0xda0cc9a69a86c60f4cc82b9be586b910419a74dbfef4ae1c78250d903a749085`
**Block:** 86566942
**Contract:** `0xE111180000d2663C0091e4f400237545B87B996B`
**Selector:** `0x3c2b4399` ✓ matches verified-correct ABI

## Decoded Order struct (12 fields)

Field names confirmed from the maker's `bytes` signature blob, which contains the
EIP-712 type string verbatim (Safe-style sig encoding includes the typed-data text
for on-chain verification):

```
struct Order {
  uint256 salt;
  address maker;       // proxyWallet — matches Polymarket data-api address
  address signer;      // EOA that signed the typed order (may be Safe operator)
  uint256 tokenId;     // ERC-1155 conditional token id (YES or NO leg of conditionId)
  uint256 makerAmount; // 6-decimal units offered by this side
  uint256 takerAmount; // 6-decimal units requested by this side
  uint8   side;        // 0 = BUY, 1 = SELL  (taker observed = 0 = BUY ✓)
  uint8   signatureType; // 1 = POLY_PROXY (65-byte sig), 3 = Safe (250-byte sig with embedded type string)
  uint256 timestamp;   // millisecond epoch of order creation
  bytes32 metadata;    // zero in this tx
  bytes32 builder;     // zero in this tx
  bytes   signature;   // off-typed-struct ECDSA / Safe contract sig
}
```

## Decoded matchOrders signature (7 args)

```
matchOrders(
  bytes32   conditionId,             // arg0  — confirmed from ground truth
  Order     takerOrder,
  Order[]   makerOrders,
  uint256   takerFillCollateral,     // arg3 — taker's USDC contribution to NegRisk mint
  uint256[] makerFillCollaterals,    // arg4 — per-maker USDC contribution (parallel array)
  uint256   ?fee_or_misc,            // arg5 — TBD (1591690 in test tx; under investigation)
  uint256[] ?per_maker_fees          // arg6 — TBD (['0'] in test tx)
)
```

The naming for `takerFillCollateral` / `makerFillCollaterals` is inferred — the
arithmetic is unambiguous:

```
takerFillCollateral + sum(makerFillCollaterals) = size_in_6_decimal_units
63,923,400        + 312,096,600                = 376,020,000     ⇔ 376.02 outcome tokens
```

This is the NegRisk complete-set mint mechanism: 376.02 USDC mints 376.02 YES + 376.02
NO tokens; the taker pays 376.02 × 0.17 = 63.9234 USDC for the YES leg, the maker pays
376.02 × 0.83 = 312.0966 USDC for the NO leg.

## Cross-reference vs data-api ground truth

| Field | Data-api | Decoded | ✓ |
|---|---|---|---|
| conditionId | `0xf30520...17003` | `arg0` = `0xf30520...17003` | ✓ exact |
| proxyWallet | `0x204f72...95e14` | `takerOrder.maker` = `0x204f72...95e14` | ✓ exact (case-insensitive) |
| side | BUY | `takerOrder.side` = 0 | ✓ (0 = BUY confirmed) |
| price | 0.17 | `takerOrder.makerAmount` / `takerOrder.takerAmount` = 351,390,000 / 2,067,000,000 = **0.17** | ✓ exact |
| size | 376.02 | `arg3 + sum(arg4)` = 376,020,000 in 6 decimals = 376.02 | ✓ exact |
| tokenId | (not exposed in this row) | 80,616,901,337,614,883,623,291,452,540,840,530,353,239,629,112,698,134,114,398,556,791,331,846,2434 | recorded; second test tx will confirm via tokenId↔outcome mapping |

## Key takeaways for the production decoder (Phase 2)

1. **Use `Order.maker` as the wallet identifier** — it equals the data-api proxyWallet,
   not the on-chain `tx.from`. The on-chain `from` is a relayer/Safe-operator address
   and will NOT appear in the watched-wallet list. Filtering on `tx.from` would miss every
   trade.

2. **Watched-wallet match in matchOrders happens on either side** — a watched wallet can
   be either the taker (`takerOrder.maker == watched`) or any of the makers
   (`makerOrders[i].maker == watched`). Decoder must check both. Some txs may have
   multiple makers — decoder returns one ParsedTrade per matched side per tx.

3. **Price** = `makerAmount / takerAmount` for the side whose order it is. Both are uint256
   in 6 decimals, so `Number(makerAmount * 10000n / takerAmount) / 10000` gives 4-dp
   precision without floating-point drift on the integer divide.

4. **Size** = the *fill* amount for that wallet, not the order's takerAmount. The fill is
   in `arg3` / `arg4[i]` divided by `(1 - price)` for buyers (NegRisk math) or `price`
   for sellers. Cleaner: derive size as `(arg3 + sum(arg4)) / 1e6` once, then it's the
   shared mint size for that match.

5. **conditionId** is `arg0` — direct mapping. Use this to look up market metadata
   (slug / question / endDate) via the existing MarketCache.

6. **side enum** confirmed at 0 = BUY. Need a SELL test tx to confirm 1 = SELL — but
   safest path is to validate from price math: if our wallet's `makerAmount/takerAmount`
   equals the published `price`, side is BUY for that wallet; if it equals `1 - price`,
   side is SELL. This avoids depending on the enum value if it ever changes.

7. **timestamp** is in **milliseconds**, not seconds. Don't pass to `new Date(ts * 1000)`.

8. **signatureType** doesn't matter for decoding the trade — we only need it for sig
   verification, which the contract already enforced. Decoder can ignore it.

## Triangulation pass — 60 txs across 30 recent blocks

Ran `scripts/recon/scan-recent-matchorders.ts 30 60` against blocks 86570277..86570306.
Polymarket activity is heavy: **2,315 matchOrders txs in 30 blocks (~77/block, ~38/sec
sustained)**. Sampled 60 for full decode.

### Confirmed across the sample

- **Side enum** — distinct values `[0, 1]` for both taker and any maker → `0 = BUY`,
  `1 = SELL`. ✓
- **SignatureType enum** — distinct values `[0, 1, 2, 3]` all observed across taker and
  maker positions. Likely: 0 = EOA / standard ECDSA, 1 = POLY_PROXY, 2 = Safe-typed,
  3 = Safe-contract-sig (250-byte blob with embedded type string). Doesn't affect decode.
- **`arg6` (uint256[])** — every observed value is `0` across 60 txs / 17 maker positions.
  Likely deprecated or reserved. Treat as ignorable.
- **Maker-count distribution** —
  ```
  1 maker  : 33 txs
  2 makers : 12
  3 makers : 7
  4 makers : 3
  7-21     : 4 (long tail — large fills crossing many counter-orders)
  ```
  Decoder MUST iterate makers, not assume 1.

### Still nuanced (not blocking Phase 2)

- **`arg5` (uint256)** — NOT a flat fee. 48 distinct values across 60 trades, no constant
  ratio to fillSize (range observed 0.27% – 1.4% of fillSize). Best read as an opaque
  per-tx field (likely a fee accumulator, builder reward, or operator nonce). Decoder
  logs it but does not depend on it.

- **Two trade modes coexist:**
  1. **NegRisk complete-set match** — taker price + maker price ≈ 1.0 (e.g. 0.74 + 0.27,
     0.90 + 0.10, 0.13 + 0.89). Both sides are technically BUYs on opposite legs (YES + NO).
     `arg3 / fillSize` ≈ taker price.
  2. **Orderbook match** — maker and taker on the SAME tokenId with opposite sides
     (e.g. taker SELL 0.67 vs maker BUY 0.67). For these the `makerAmount / takerAmount`
     ratio of a SELL order can be wildly off (limit prices like 100 or 1054 observed —
     orders posted with throwaway limits, real fill price comes from `arg3 / fillSize`).

- **Real fill price** — derive from `arg3 / fillSize` (taker side) and
  `arg4[i] / fillSize` (per maker), NOT from `Order.makerAmount / Order.takerAmount`.
  The latter is the order's LIMIT price; price improvement ~1pp is normal.

### Confirmed unblocked for Phase 2

The remaining ambiguity (arg5 meaning, exact SELL-side accounting in orderbook matches)
does not block decoder construction. The decoder will:
- Output one ParsedTrade per Order whose `maker` is in the watched-wallet list
- Derive size as `(arg3 + sum(arg4)) / 1e6`
- Derive each watched wallet's fill price from its collateral contribution / fillSize
- Log `arg5`, `arg6`, and any rows where price-math sanity fails for forensic review
- Validate against data-api ground truth via golden-vector tests in Phase 2

If shadow validation in Phase 4 surfaces persistent edge cases, we revisit then.

## Working RPC pair (for Phase 3 multi-RPC failover)

| RPC | Status (2026-05-08) | Latest block |
|---|---|---|
| `https://polygon-bor-rpc.publicnode.com` | ✓ healthy | 86568791 |
| `https://polygon-pokt.nodies.app` | ✓ healthy | 86568793 |
| `https://polygon-rpc.com` | ✗ tenant disabled | — |
| `https://rpc.ankr.com/polygon` | ✗ unauthorized | — |
| `https://polygon.llamarpc.com` | ✗ no response | — |
| `https://polygon.blockpi.network/v1/rpc/public` | ✗ 521 | — |
| `https://1rpc.io/matic` | ⚠ stale (block 79818149, 6.7M behind) | unsafe |

publicnode and pokt-nodies are in close lock-step (2-block delta) — good failover pair.
