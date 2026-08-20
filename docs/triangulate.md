# Triangular

Finds Solana wallets that bought **all** of 2–5 given tokens, ranked by combined realized
PnL. Local web app, single user, no auth.

## Setup

```bash
npm install
cp .env.example .env      # then add your key
npm start                 # http://127.0.0.1:3000
```

You need a free Solana Tracker API key: <https://www.solanatracker.io/data-api>
(Free plan: 10,000 requests/month, 3 req/s). Put it in `.env` as `SOLANA_TRACKER_API_KEY`.
`.env` is gitignored; `.env.example` documents every setting.

## How it works

The expensive way to do this would be to list every trader of every token and intersect the
lists. Instead:

1. **Metadata** — `GET /tokens/{mint}` for each token, giving pool creation time (the
   reference point for the sniper filter), deployer addresses, and a holder count.
2. **Pick the anchor** — the token with the fewest holders, from the metadata above. No
   request: the traders endpoint's `pagination.total` looks like a global count but actually
   reports the size of the page just returned, so it can't be used for this.
3. **Anchor enumeration** — fully paginate the anchor's trader list, 200 per page.
4. **Batch intersect** — `POST /v2/pnl/positions/batch` (200 wallet×token pairs per request)
   asks only "which of these anchor wallets also traded token B?" The response's `notFound`
   array is the intersection test. Wallets are narrowed token by token, so each round is
   cheaper than the last.
5. **Filter and rank** — entirely local.

6. **Score** — computed locally from the data already in hand, plus a cached price series
   per token for entry market cap.

Cost therefore scales with the **smallest** token in the query, not the largest. A two-token
search measured 24 requests end to end, so the free tier covers hundreds of searches a month.
Everything is cached in SQLite, so repeat searches are free — a re-run of a cached query
costs 0 requests and completes in milliseconds.

## Filters

Deliberately few, and all free — every one is computed from token-side data already fetched,
so none of them costs a request per wallet.

| Filter | Default |
|---|---|
| Exclude snipers (first buy within N seconds of launch) | 30s |
| Exclude bots (total swaps across the queried tokens) | > 500 |
| Exclude token deployer wallets | on |
| Exclude arbitrage, bot and pool accounts | on |
| Require realized profit on all tokens (or relax to N-of-M) | all |

Hold time, entry price, consistency and trading cadence are **reported in the Score column
rather than filtered on.** An earlier version enforced them as hard filters, each needing a
request per wallet, and a two-token search cost 576 requests — most of a week's free-tier
budget for one query. The same information now arrives as a score for 24.

Launch time is **derived from the earliest first-buy actually observed**, not from pool
`createdAt`. Pool dates are wrong in both directions: pools are often created well before
trading opens (BONK reports 8 Dec against a ~25 Dec start), and the earliest pool that
reports a date is often a later migration (WIF reports 2024-05 against a 2023-12 start).

Wallets that only ever *received* the token — airdrops, transfers — are excluded at the API
level via `excludeZeroBuys`, so the intersection is genuine buyers only.

## Trending panel

A sidebar lists the top 15 trending Solana tokens with 24h volume and price change. "Add"
drops a mint into the next empty field; each input also has a `▾` picker for the same list.

Data comes from **GeckoTerminal** (`/networks/solana/trending_pools`) — free, keyless, and it
bills against nobody's quota, so the panel can never eat into your search budget. Cached
server-side for 5 minutes and shared through a single in-flight promise, so no amount of
clicking causes more than one upstream fetch per 5 minutes.

DexScreener was considered and rejected: its free "top" endpoint is `/token-boosts/top/v1`,
which ranks by `totalAmount` — the sum a project *paid* to promote itself. That surfaces
marketing spend rather than trading activity.

## Wallet scoring

Each wallet gets a 1–10 score with a traffic-light badge; click it for a per-component
breakdown showing weight, raw value, sub-score and any caveat. All thresholds live in
`src/scoring/config.ts` — that file is the entire tuning surface.

**Hard exclusions** run first and drop the wallet outright: sniper (median first buy within
60s of launch), transfer-inflated PnL (sold more than was ever bought via swaps, so there's
no real cost basis), and deployer. *Deployer-funded* is not implemented — it needs the
wallet's SOL funding source, which this data source doesn't expose.

| Component | Weight | Source |
|---|---|---|
| Hold-time match | 25% | Median hold; full marks 2–21 days, tapering to scalper and bagholder |
| Entry earliness | 15% | Median market cap at first buy, from OHLCV |
| PnL quality | 25% | Profit factor and single-position concentration |
| Breadth | 15% | Distinct profitable positions |
| Human cadence | 10% | Sleep gaps and timing irregularity — **Tier 2 only** |
| Recency | 10% | Realized activity in the last 30 days |

**Unmeasurable components are dropped, not guessed.** Rather than scoring a component it
can't evaluate as a neutral 0.5 — which would quietly drag every wallet toward the middle —
its weight is redistributed across the components that could be measured, and the breakdown
shows the coverage percentage and marks what was skipped.

Two components need explaining. *Breadth* carries no information within the queried set:
it's capped at 5 and "require profit on all tokens" pins it to exactly N. It becomes real
only with wallet-wide data — which is **free** when the track-record filter has already run,
since that call has already happened. *Profit factor* has the same problem in reverse: with
profit-on-all enabled, gross losses are zero by construction, so that half reports itself
unmeasured and concentration carries the component alone.

Scores are for reference, not gatekeeping: nothing is filtered out by its score, and the
table sorts by it so the most on-profile wallets surface first.

### Two tiers

**Tier 1** is the default and makes **no per-wallet API calls at all** — everything comes from
the per-token data already fetched for the triangulation. Breadth and human cadence can't be
measured that way, so their weight is redistributed and the badge reports ~75% coverage. The
only network cost is the OHLCV
price series, which is per *token* and cached, so it doesn't scale with wallet count.

**Tier 2** is the per-row "Deep check" button. It fetches the wallet's own trade history via
`/wallet/{wallet}/trades` (1,000 trades per page), which in testing cost **2 requests for
1,332 trades**, and unlocks human cadence and true breadth. It runs only when clicked, never
automatically, and is cached permanently — past trades don't change.

## Filter cascade

Filters are ordered by cost, not by importance. Everything free runs first, so the one
filter that costs a request per wallet runs against the smallest possible set:

```
anchor traders → bought all → free filters → activity → track record → results
     1,200          843           498         80 → 4       4 → 2          2
```

The free stage is early/sniper timing, hold time, lifetime trade ceiling, identity, deployer
and profit — all computed from data already fetched. The two paid stages cost one request per
wallet each, so they run last and in order of selectivity: the activity window typically
removes ~95%, which means the track-record check only ever runs on the handful that survive
it. Reordering these two would multiply the cost of the second by twenty.

The paid stages are capped (default: top 300 by realized profit, adjustable in the UI). That
cap is the main driver of query cost: a search checking 300 wallets costs ~330 requests, so
budget roughly 30 such searches a month against the free tier's 10,000. Both checks are
cached per wallet, so overlapping searches get cheaper.

## Things worth knowing

- **The provider's PnL history starts 2023-12-30.** Verified against tokens launched years
  apart — BONK (2022), RAY (2021), WIF and POPCAT all report their earliest first-buy at
  `2023-12-30T13:10Z`, to the minute. For any token that launched before then, its early
  buyers are simply absent and its realized PnL omits every earlier trade. Triangular detects
  this, warns you, and **skips the timing filters for that token** rather than rejecting every
  wallet for looking "late". Treat such a token's PnL as a floor, not a total — and prefer
  querying tokens launched after that date, where the data is complete.

- **PnL is in USD**, and it is Solana Tracker's number, not ours. We don't recompute it from
  raw trades, so we can't audit their cost-basis attribution or fee treatment. If a figure
  disagrees with another tracker, try switching PnL mode (strict / adjusted / raw) — that's the setting
  most likely to explain a gap.
- **We inherit their wallet set.** If their arbitrage heuristic wrongly drops a wallet, it's
  invisible to us. Turn off "exclude arbitrage wallets" if you suspect that.
- **Pool creation times are unreliable on older tokens.** Only some pools report `createdAt`,
  and the earliest one that does isn't always the original pool — WIF, for instance, reports
  2024-05-18 against a late-2023 launch. When wallets are found buying *before* that
  timestamp, the UI warns you and the sniper filter is skipped for that token rather than
  wrongly excluding every early buyer. Treat the "1st buy" column as unreliable whenever you
  see that warning.
- **Caching is time-based** (`CACHE_TTL_HOURS`, default 24). For a token still actively
  trading, tick "Ignore cache and refetch" to get current numbers.
- **Guard rails**: `MAX_REQUESTS_PER_QUERY` (default 1500) stops a single search draining
  your monthly quota; `ANCHOR_WALLET_CAP` (default 20,000) stops enumeration on a very large
  anchor token and flags the results as capped in the UI.

## API efficiency

- **Token bucket** rate limiter at 3 req/s in front of every external call, with exponential
  backoff and jitter, honouring `Retry-After`.
- **In-flight deduplication**: identical GETs issued while one is already running share the
  same promise, so concurrent searches touching the same mint cause one upstream call.
- **Cache-first everywhere**: the cache is consulted before any network request and only the
  genuinely missing pieces are fetched. Negative results are cached too, so a wallet known to
  have no position in a token is never re-probed.
- **Immutable data never expires**: price series, deep checks and closed trade ranges are kept
  indefinitely, since historical data doesn't change.
- **No per-wallet calls during intersection or Tier-1 scoring.**
- A footer under the results reports requests made versus served from cache, per search.

### The one thing not built as specified

Caching *full per-mint trade history* is the right model but not affordable here.
`/trades/{mint}` returns 250 trades per page, so a token with a million trades is thousands of
requests against a 10,000/month budget — caching makes the second query free, but the first
can exhaust the month. The per-*wallet* route used by Tier 2 gets the same per-trade inputs
for 1–3 requests, which is why deep check is built on it instead.

## Layout

```
src/
  server.ts     Fastify server, SSE progress stream, static hosting
  pipeline.ts   the five phases above
  client.ts     rate limiter (3 req/s), retry with backoff, per-query request budget
  cache.ts      SQLite cache, including negative caching of "no position"
  normalise.ts  tolerant readers for the provider's response shapes
  config.ts     env loading and filter defaults
  scoring/      config.ts (all thresholds), exclusions, and one file per component
  trending.ts   GeckoTerminal client with a 5-minute shared cache
  prices.ts     OHLCV price series for entry market cap
  deepcheck.ts  Tier-2 per-wallet trade history
public/         vanilla HTML/CSS/JS frontend, no build step
data/cache.sqlite  created on first run, gitignored
```
