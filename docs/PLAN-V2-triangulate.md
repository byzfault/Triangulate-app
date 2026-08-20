# Triangular v2 — Trending, Scoring, Optimisation

Status: **approved and implemented.** See README.md for how the built system works.

Verified live after building: trending returns 15 tokens then serves from cache; a two-token
search scores every wallet at Tier 1 with 90% weight coverage (cadence correctly skipped);
a deep check read 1,332 trades in 2 requests, reached 100% coverage, and cost 0 requests on
the second call.

---

## 1. Trending panel

### Endpoint: GeckoTerminal, not DexScreener

`GET https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1`

Free, no key, no account, and — importantly — **it doesn't touch the Solana Tracker quota**,
so the trending panel can never eat into your search budget. Verified live: 20 pools per
page, each carrying everything the panel needs.

| Field | Path |
|---|---|
| Name / symbol | `attributes.name` (e.g. "ANSUM / SOL") |
| Mint | `relationships.base_token.data.id` → `solana_<mint>` |
| 24h volume | `attributes.volume_usd.h24` |
| 24h change | `attributes.price_change_percentage.h24` |
| Market cap | `attributes.market_cap_usd`, `attributes.fdv_usd` |

Two pages gives 40 pools, deduped by mint and trimmed to the top 15 by 24h volume.

**Why not DexScreener, which you suggested.** Its free trending-ish endpoint is
`/token-boosts/top/v1`, and that's a **paid-promotion leaderboard** — the ranking field is
literally `totalAmount`, the amount the project paid to boost. Verified live: 30 entries, 17
Solana. That surfaces whoever is spending on marketing, not what's actually trading. For
finding real early-buyer activity it's actively misleading, so I'd rather not use it.

Solana Tracker also has a trending endpoint, but it bills against the same 10,000/month the
searches use, so I've ruled it out.

### Caching and behaviour
- 5-minute TTL, held server-side in SQLite, never per-browser. The UI hits
  `GET /api/trending`, which serves cache and only refetches when the TTL has expired —
  so hammering the panel can't cause more than one upstream fetch per 5 minutes.
- One in-flight promise shared across concurrent requests (same dedupe as item 3).
- "Add" fills the first empty input; if none is empty and there are fewer than 5, it appends
  a row; at 5 it disables with a tooltip. Duplicate mints are rejected with the existing
  inline validation.
- Each input also gets a dropdown listing the same cached trending set.
- Styled as a second card to the right of the existing one, same slate/teal palette, same
  border/shadow treatment. Stacks below on narrow screens.

---

## 2. Wallet scoring

### Module structure

```
src/scoring/
  config.ts        every weight, threshold and band — the only file you edit to tune
  types.ts         ScoreBreakdown, ComponentScore { key, label, weight, raw, score, tier, measured }
  exclusions.ts    hard gates, run before scoring
  index.ts         scoreWallet(row, ctx) → ScoreBreakdown
  components/
    holdTime.ts  entryEarliness.ts  pnlQuality.ts  breadth.ts  cadence.ts  recency.ts
```

Each component is a pure function `(row, ctx, cfg) => { raw, score0to1, measured }`. The
index normalises the weighted sum to 1–10. Nothing in `components/` reads config directly —
thresholds are passed in, so `config.ts` is genuinely the single tuning surface.

### Hard exclusions

| Gate | Feasible now? |
|---|---|
| Sniper — median first buy within 60s of launch | **Yes.** Already computed, using the derived launch time. |
| Transfer-inflated PnL — sold without corresponding swap buys | **Yes, and cheap.** `volume.tokensSold > tokensBought × (1+ε)` or `sells > 0 && buys === 0` catches it from data already in hand. |
| Deployer | **Yes.** Already implemented. |
| Deployer-**funded** | **No.** This needs the wallet's SOL funding source, which is a chain-level lookup Solana Tracker doesn't expose. I'd implement plain deployer exclusion and leave this out rather than fake it. Flagging now because it's in your spec. |

### Tier-1 feasibility — the honest version

You asked for Tier 1 to cost zero extra API calls. Here is what that actually buys, given
the per-(wallet, token) aggregates we hold after triangulation:

| Component | Weight | Tier-1 status |
|---|---|---|
| Hold-time match | 25% | **Exact.** `holdTimeSecs` per position, median across queried tokens. |
| Entry earliness | 15% | **Proxy, or exact for 1 request/token.** We have first-buy *time*, not market cap. See below. |
| PnL quality | 25% | **Coarse, and degenerate under default filters.** See below. |
| Breadth | 15% | **Degenerate.** Capped at the queried set (max 5), and "require profit on all" forces it to exactly N. Carries no information at defaults. |
| Human cadence | 10% | **Not computable.** Needs per-trade timestamps; we only hold first/last per token. |
| Recency | 10% | **Good proxy.** Latest `lastTrade` across queried tokens. |

Three problems worth deciding on before I build:

**Entry earliness needs market cap.** We have the first-buy timestamp but no price at that
moment. Two options: use time-after-launch as the proxy (zero calls, already computed), or
fetch `/chart/{token}` OHLCV once per token and map timestamp → price → market cap using the
supply already in the metadata. The second is **1 request per token, token-side**, so it
respects your "no per-wallet calls" rule and is genuinely cheap. I recommend it.

**PnL quality is degenerate at defaults.** Profit factor is gross wins ÷ gross losses, but
"require realized profit on all tokens" is on by default, which forces gross losses to zero
and profit factor to infinity for every surviving wallet. The component can only discriminate
if that filter is relaxed. Same for "no single trade >40%": at Tier 1 we only have per-*token*
realized, so it becomes per-token concentration, not per-trade.

**Breadth and cadence are 25% of the weight and neither is meaningful at Tier 1.** I'd rather
not have a quarter of the score be invented. Proposal: each component reports
`measured: true|false`; unmeasured ones are excluded and the remaining weights renormalised,
with the badge marked "Tier 1" and the breakdown showing exactly which components were
skipped. A Tier-1 score would then be an honest weighting of hold time, entry, PnL quality
and recency.

**One free upgrade:** if you leave the existing activity and track-record filters on, those
per-wallet calls have *already happened* for every surviving wallet. That data — wallet-wide
ROI, win rate, closed-position count, distribution, average hold, 14-day trade count — makes
breadth and recency properly measurable at **no additional cost**. Scoring will use whatever
is already in hand and mark it measured. So the Tier-1/Tier-2 line is really "no *new* calls",
which I think is your actual intent.

### Tier 2 — "Deep check"

`GET /wallet/{wallet}/trades` — verified live, **1,000 trades per page**, fields
`tx, from, to, price, volume, wallet, program, time`.

Most candidate wallets have 500–3,000 lifetime trades, so a deep check is **1–3 requests**.
That's cheap enough to be genuinely useful per-wallet, on click only, never automatic. It
unlocks the exact versions: per-trade timestamps → human cadence and sleep gaps; per-trade
PnL → true single-trade concentration; full token list → true breadth; month-by-month
consistency. Results cached permanently per wallet, badge re-renders as "Tier 2".

### Display
Badge in a Score column: green 8–10, amber 5–7, red 1–4; hard-excluded rows show a grey
"excluded" chip with the reason. Click expands a breakdown row: each component with its
weight, raw value, 0–1 score, and whether it was measured or skipped. "Deep check" button
per row.

---

## 3. API optimisation

Already in place from v1: token-bucket rate limiter at 3 req/s, exponential backoff with
jitter honouring `Retry-After`, cache-first reads throughout, negative caching, and a live
request counter plus a cache-hit count in the results header.

New work:

- **In-flight dedupe.** A promise map keyed by request URL so concurrent or repeat searches
  touching the same mint share one fetch. Straightforward, no downside.
- **Immutable/incremental caching.** Cache entries for *closed* time ranges stop expiring,
  and re-queries fetch only the delta past the stored cursor. This is the right model and I'll
  build it for the trader and position data.
- **Explicit footer.** Requests made vs served from cache, per search, in a persistent footer
  rather than only in the results header.
- **No per-wallet calls during intersection or Tier-1 scoring.** Will hold.

### One thing I can't do as specified

> Persistent disk cache of trade history **per mint** … never refetch full history

The architecture is right, but the economics don't work here. `/trades/{mint}` returns
**250 trades per page** (verified). WIF has millions of trades — that's tens of thousands of
requests for one token, against a 10,000/month budget. Even a modest token with 100k trades
costs 400 requests. Caching makes the *second* query free, but the first can exhaust your
month.

So I'd propose: build the incremental per-mint trade cache with a **pre-flight estimate and an
explicit opt-in** — it shows "this will cost ~N requests, proceed?" and is off by default. For
per-trade analysis the per-*wallet* route (1–3 requests) is roughly a thousand times cheaper
and gets you the same scoring inputs, which is why Tier 2 is built on it.

---

## Decisions I need from you

1. **GeckoTerminal for trending** instead of DexScreener boosts — OK?
2. **Entry earliness**: 1 OHLCV request per token for true entry market cap (recommended), or
   zero-call time-after-launch proxy?
3. **Unmeasured components**: renormalise weights and label them, or force a neutral 0.5?
4. **Per-mint trade cache**: build it as opt-in with a cost estimate, or skip it and rely on
   the per-wallet Tier-2 route?
5. **Deployer-funded exclusion**: accept dropping it, or should I look for another data source?
