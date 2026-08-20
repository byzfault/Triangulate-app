# Solana Toolkit

A suite of local Solana wallet-analysis tools, sharing one server, one cache and one API
budget. Single user, no auth, runs on `127.0.0.1`.

```bash
npm install
cp .env.example .env      # add your Solana Tracker key
npm start                 # http://127.0.0.1:3000
```

| Tool | What it answers |
|---|---|
| **[Triangulate](docs/triangulate.md)** (`/triangulate/`) | Which wallets bought *all* of these 2–5 tokens, and which of them are actually good? |
| **Copy Tracker** (`/copy-tracker/`) | This wallet is profitable — who is it copying? |
| **API Usage** (`/usage/`) | What has the suite spent, and what is left? |

Navigate between them from the burger menu in the top bar.

---

## Copy Tracker

You follow a public wallet that does well. It is probably not finding these coins itself — it
is copying someone quieter. This finds who.

Enter the wallet and the tokens it bought. For each of those buys, the tool reads the trades
in the seconds immediately before it and records everyone who bought in that gap. Do that
across several tokens and the coincidences fall away, because the same wallet does not keep
turning up by chance. What survives is a shortlist with a confidence score.

### Why it is affordable

The obvious approach — pull each token's trade history and search it — is thousands of
requests per token. But `GET /trades/{mint}` takes a **plain millisecond timestamp as its
cursor** and returns newest-first, so seeding it with the follower's buy time hands back the
250 trades immediately before that instant. That is exactly the window, for one request.

```
follower's buy history   1–3 requests (cached, so later traces are free)
each buy's window        1 request each
────────────────────────────────────────
a 5-token trace          ~8 requests
a re-run                 0 requests, 0 ms
```

Measured, not estimated: a four-token trace cost 6 requests, and re-running it cost 0.

### Confidence scoring

Each candidate gets 0–10 with a colour-coded badge; click it for the breakdown.

| Component | Weight | What it measures |
|---|---|---|
| Timing regularity | 35% | Coefficient of variation of the lead times |
| Lead frequency | 20% | How many of the buys it got in front of |
| Repeats across tokens | 20% | Distinct coins the pattern held on |
| Beats chance by | 15% | Observed leads ÷ leads its own activity predicts |
| Lead time | 10% | Whether the median gap looks like a copy bot |

**Timing regularity carries the most weight**, which is the one non-obvious choice here.
Lead frequency and token coverage both saturate for any wallet that trades constantly, so
ranking on those alone puts the busiest MEV bot on top. What a copier cannot disguise is a
*repeatable* delay — the same few seconds behind, every time. A CV near zero across several
tokens is a machine following a machine, and nothing else in this data looks like it.

**The base-rate gate.** A weighted average cannot express "this evidence is void". A wallet
responsible for 45% of all buys in every window maxes out two components, and one weak
component cannot drag it back — in testing it scored 7.5 and landed in the green band. So
lift is applied *twice*: once as a component, and again as a multiplier on the finished
score. At or below chance the score collapses to a fifth of itself. That same bot now scores
3.8, while a genuine copier on the same data scores 8.7. The UI says when the gate has fired
and by how much.

Unmeasurable components are **dropped and their weight redistributed**, not scored as a
neutral half — the same rule Triangulate uses, for the same reason: a guessed component drags
everything toward the middle and hides the real signal. Timing regularity needs three
observations before it means anything, and says so until it has them.

### It gets stronger over time

Every buy ever analysed stays on record, and the score is computed over **all** of it, not
just today's search. Run it again next week with two new coins and the same candidates either
keep leading or they don't. That accumulation is the point — one wallet buying ahead of
another once is a coincidence, and no amount of scoring fixes a single data point.

### Honest limits

- **Correlation, not proof.** A wallet that consistently buys 8 seconds before another is
  strong circumstantial evidence and nothing more. Both could be copying a third source, or
  reading the same signal.
- **Same-block leads are ambiguous.** Under a second usually means a bundle, not a copy, and
  scores low rather than zero.
- **The window can be incomplete** on a very busy token, where 250 trades don't span the whole
  lookback. The UI flags those events rather than quietly under-reporting.
- **A wallet that only ever received tokens** by transfer has no buy to anchor a window to.
- **The free log has coarser timing than paid history.** GeckoTerminal reports whole seconds,
  Solana Tracker milliseconds. Rounding compresses the spread of tight lead times, which
  flatters timing regularity — the heaviest component. A candidate built purely from
  free-logged windows can look marginally more machine-like than it is.

---

## Cost model: free, quota, paid

Three tiers, and the tool always spends the cheapest one that can answer.

**Free — GeckoTerminal.** Keyless, unmetered, billed to nobody. It gives away the last ~300
trades on a pool but offers no cursor, so it cannot reconstruct history. What it *can* do is
watch. The **free trade logger** polls tracked tokens often enough that consecutive polls
overlap, building a continuous record of who bought when, for nothing. Any window it already
covers is analysed at zero API cost — so track a token before your wallet moves again and
that trace is free. Coverage ranges are stored explicitly, so "nobody bought" is never
confused with "we weren't watching".

**Quota — Solana Tracker free tier.** The metered allowance, 10,000/month by default. Used
only for history the free logger never saw.

**Paid — credit.** Off by default. When the allowance runs out the tools **stop** rather than
silently spending money; enable `PAID_CREDITS_ENABLED` with a `PAID_CREDIT_LIMIT` to continue.
The limit is a hard per-period ceiling, checked before every attempt including retries, so an
unattended background job cannot run up a bill.

The `/usage/` page shows all three with a daily breakdown and per-endpoint totals. Wallet and
token addresses are stripped before anything is written, so the usage log stays a record of
request *shapes* rather than a second copy of what you searched.

---

## Layout

```
src/
  server.ts              mounts both tools, serves pages, suite-level routes
  shared/
    db.ts                one SQLite handle for the whole suite
    client.ts            rate limiter, retry, per-query budget, tier gate
    cache.ts             token/position/price caching
    usage.ts             free/quota/paid accounting
    gecko.ts             GeckoTerminal — the free tier
    jobs.ts              SSE job registry, shared by both tools
    trending.ts          trending tokens (free)
    config.ts, types.ts
  tools/
    triangulate/         pipeline, scoring/, prices, deepcheck, routes
    copytracker/         trace, confidence, store, logger, routes
public/
  shared/                nav, base.css, logos
  triangulate/  copytracker/  usage/
data/cache.sqlite        created on first run, gitignored
```

Both tools share the client, cache, rate limiter, job/SSE plumbing and nav. Adding a third
tool means a directory under `src/tools/`, a page under `public/`, and one entry in
`public/shared/nav.js`.

The shared cache is what makes the suite cheaper than the sum of its parts: a wallet's trade
history fetched by Copy Tracker is already paid for when Triangulate wants it.
