import { config } from '../../shared/config.js';
import { fetchPoolTrades, fetchTokenPools } from '../../shared/gecko.js';
import { store } from './store.js';

/**
 * The free half of the cost model.
 *
 * GeckoTerminal gives away the last ~300 trades on a pool but offers no way to page back
 * past them, so history can only be bought. What it *can* do is watch: poll a tracked token
 * often enough that consecutive polls overlap, and the log becomes a continuous record of
 * who bought when — built for nothing, and growing for as long as the server runs.
 *
 * A window that this log already covers costs zero Solana Tracker requests to analyse. So
 * the tool gets cheaper the longer it runs, and a wallet tracked before it makes its next
 * move can be traced entirely free.
 */
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastError: string | null = null;
let pollsCompleted = 0;

export function loggerStatus() {
  return {
    running: timer !== null,
    intervalSecs: config.loggerIntervalSecs,
    tracked: store.tracked(),
    pollsCompleted,
    lastError,
    log: store.logStats(),
  };
}

export function startLogger() {
  if (timer !== null) return;
  // A first pass immediately, so adding a token gives feedback without waiting a full cycle.
  void tick();
  timer = setInterval(() => void tick(), Math.max(30, config.loggerIntervalSecs) * 1000);
  timer.unref();
}

export function stopLogger() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}

async function tick() {
  if (running) return; // a slow cycle must not overlap the next one
  running = true;
  try {
    for (const t of store.tracked()) {
      let pool = t.pool;
      if (!pool) {
        const pools = await fetchTokenPools(t.mint);
        pool = pools[0] ?? null;
        if (!pool) continue;
        store.track(t.mint, pool, t.symbol);
      }

      const trades = await fetchPoolTrades(pool);
      if (trades.length > 0) store.appendTrades(t.mint, trades);
      store.markPolled(t.mint);
      pollsCompleted += 1;
    }
    lastError = null;
  } catch (err) {
    lastError = (err as Error).message;
  } finally {
    running = false;
  }
}

/** Adds a token to the watch list and resolves its most liquid pool straight away. */
export async function trackToken(mint: string, symbol: string | null) {
  const pools = await fetchTokenPools(mint);
  store.track(mint, pools[0] ?? null, symbol);
  if (pools[0]) {
    const trades = await fetchPoolTrades(pools[0]);
    if (trades.length > 0) store.appendTrades(mint, trades);
    store.markPolled(mint);
  }
  return pools[0] ?? null;
}
