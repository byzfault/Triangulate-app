# Triangular — Data-Source Plan v3 (Solana Tracker, free tier, USD)

Status: **approved and implemented.** See README.md for how the built system actually works.

Three things in this plan turned out differently once tested against the live API:

- **Phase 2 (size probe) was deleted.** `pagination.total` reports the size of the page just
  returned, not a global trader count — with `limit=1` it returns 1 for every token. Anchor
  selection now uses the `holders` count that Phase 1's metadata already returns, which costs
  nothing and removes a request per token.
- **The batch path is `POST /v2/pnl/positions/batch`.** The other candidate 404s. `pnlMode`
  has to be passed there explicitly or it defaults to `strict` while the anchor list uses the
  user's setting.
- **Pool `createdAt` is missing on many pools**, and the earliest pool that reports one isn't
  always the original. The sniper filter now only fires on non-negative deltas and warns when
  a token's reference timestamp looks wrong.

Single provider: Solana Tracker Data API, free tier (10,000 requests/month, 3 req/s, €0).
One API key, no paid dependency. PnL denominated in USD, as agreed.

## Pipeline

### Phase 1 — Token metadata · 1 request per token
`GET /tokens/{tokenAddress}`

Returns `pools[]` with `createdAt` (ms) and `deployer`, plus decimals and symbol.
- `pools[].createdAt` → first-pool-trade reference for the sniper filter and the
  "first buy relative to first pool trade" column.
- `pools[].deployer` → deployer-exclusion filter.

### Phase 2 — Size probe · 1 request per token
`GET /v2/pnl/tokens/{token}/traders?limit=200` — read `pagination.total` from page 1.

Tells us how many traders each token has before we commit to enumerating any of them.

### Phase 3 — Anchor enumeration · ~N requests, smallest token only
Fully paginate the trader list of the **token with the fewest traders**, 200/page:

```
GET /v2/pnl/tokens/{token}/traders
    ?limit=200&cursor=…
    &sort=realized&direction=desc
    &excludeArbitrage=true
    &excludeZeroBuys=true
```

- `excludeZeroBuys=true` implements your rule directly: **transfers and airdrops don't
  count**, only wallets with real buys.
- `excludeArbitrage=true` strips a chunk of bot noise before we filter.

A 2,000-trader anchor = 10 requests.

### Phase 4 — Batch positions for the other tokens · ~M requests
`POST /v2/pnl/positions/batch` — **200 wallet×token pairs per request**

```json
{ "pairs": [ { "wallet": "…", "token": "…" } ] }
```

Rather than enumerating every trader of every token, we ask only: "of these anchor wallets,
which also traded token B and C?" 2,000 anchor wallets × 2 other tokens = 4,000 pairs =
20 requests. Unmatched pairs come back in a `notFound` array — that *is* the intersection
test.

The response is the **full position schema, not a reduced one**: `realized`, `unrealized`,
`invested`, `proceeds`, `roi`, `balance`, `costBasis`, `counts.buys/sells`,
`timing.firstBuy/firstTrade/lastTrade`. Everything the results table needs.

This is the core cost saving, and it removes pagination blow-up on large tokens entirely —
a 200k-trader token costs the same as a small one, because we never enumerate it.

### Phase 5 — Intersect, filter, rank · 0 requests
All local, over cached data:
- Keep wallets with `counts.buys > 0` in **every** token (or N-of-M if relaxed)
- Sniper: `timing.firstBuy − pools[].createdAt < 30s`
- Bot: total buys+sells across queried tokens > 500
- Deployer: wallet appears in any queried token's `pools[].deployer`
- Profit-on-all / N-of-M
- Rank on summed `pnl.realized` (USD) across the queried tokens

## Estimated request volume

Typical 3-token query, anchor token ~2,000 traders:

| Phase | Requests |
|---|---|
| 1 · Token metadata | 3 |
| 2 · Size probe | 3 |
| 3 · Anchor enumeration | ~10 |
| 4 · Batch positions (4,000 pairs) | ~20 |
| 5 · Intersect, filter, rank | 0 |
| **Total** | **~36** |

Free tier 10,000 requests/month → **~275 fresh queries/month**, ~12s each at 3 req/s.
Caching (SQLite, keyed per mint and per wallet×token) makes repeat queries free.

Cost scales with the size of the **smallest** token in the query, not the largest. A
5-token query with a 5,000-trader anchor is ~135 requests — still trivial against the quota.

## Known limitations, stated plainly

1. **PnL is Solana Tracker's, not ours.** We can't audit their cost-basis attribution or fee
   treatment. If a number disagrees with GMGN in Step 2, I can show you the gap but not fix
   it. `pnlMode` (strict / adjusted / raw) is exposed as a UI setting since it changes how
   suspect positions count toward realized PnL — worth trying if numbers look off.
2. **We inherit their wallet set.** If their arbitrage heuristic wrongly drops a wallet, we
   never see it. Mitigation: `excludeArbitrage` is a UI toggle, not hardcoded.
3. **Endpoint path discrepancy.** Their index lists `/v2/pnl/batch/positions`; the endpoint
   page says `POST /v2/pnl/positions/batch`. I'll probe both on first run and pin whichever
   answers.
4. **No time cap needed.** Trader data covers the token's full lifetime, so the original
   30-day cap is unnecessary. The "capped" flag instead covers the anchor-enumeration cap
   (default 20,000 wallets) if a query's smallest token is enormous.
5. **Minimum 2 tokens**, per the mockup, not the 1–5 in the brief.

## Frontend

Extending `wallet-triangulator-mockup.html` — vanilla HTML/JS, no build step, same teal
design tokens. Additions:
- Per-token progress states (metadata → traders → intersecting) with a live request counter
- Filter checkboxes with editable thresholds, on by default
- Results table: wallet (→ Solscan, GMGN), realized USD per token, combined realized USD,
  buy/sell counts, first-buy delta vs first pool trade, remaining balance
- Default sort: combined realized USD desc · CSV export

## Stack

- Node.js + TypeScript, Fastify
- SQLite (`better-sqlite3`) for the cache
- Static frontend served by the same server
- `.env` (gitignored) + `.env.example`, `SOLANA_TRACKER_API_KEY`
- Rate limiter pinned to 3 req/s, exponential-backoff retry on 429, per-query request counter

## To proceed I need

1. Approval of this pipeline
2. Your Solana Tracker API key — free at solanatracker.io/data-api
3. A token mint you have GMGN numbers for, to sanity-check against in Step 2
