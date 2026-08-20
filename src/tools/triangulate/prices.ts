import { api, BudgetExceededError, type RequestBudget } from '../../shared/client.js';
import { cache } from '../../shared/cache.js';
import type { PriceSeries } from './scoring/types.js';
import type { TokenMeta } from '../../shared/types.js';

/** Their response key is `oclhv`, not `ohlcv` — that spelling is theirs, not a typo here. */
interface ChartResponse {
  oclhv?: Array<{ close?: number; open?: number; time?: number }>;
}

const WEEK_SECS = 7 * 86400;

/**
 * Builds a price series for valuing wallet entries.
 *
 * Two requests per token, deliberately: a daily series covering the whole life of the token,
 * plus a 15-minute series over its first week. Early buyers are the entire point of this
 * tool, and a daily candle is far too coarse to distinguish an entry at hour 2 from one at
 * hour 20 — which is exactly where the interesting difference lies.
 */
export async function fetchPriceSeries(
  token: TokenMeta,
  budget: RequestBudget,
): Promise<PriceSeries | null> {
  const supply = cache.getSupply(token.mint);

  const cached = cache.getPriceSeries(token.mint);
  if (cached !== undefined) {
    budget.hit();
    return cached;
  }

  const points = new Map<number, number>();

  const load = async (query: Record<string, string | number>) => {
    const raw = await api.get<ChartResponse>(`/chart/${token.mint}`, query, budget);
    for (const candle of raw?.oclhv ?? []) {
      const t = typeof candle.time === 'number' ? candle.time : null;
      const p = typeof candle.close === 'number' ? candle.close : candle.open;
      if (t !== null && typeof p === 'number' && Number.isFinite(p) && p > 0) points.set(t, p);
    }
  };

  try {
    await load({ type: '1d' });

    if (token.launchAt !== null) {
      const from = Math.floor(token.launchAt / 1000);
      await load({ type: '15m', time_from: from, time_to: from + WEEK_SECS });
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    // A price series is an enrichment, not a requirement — the entry component simply
    // reports itself unmeasured if this fails.
    if (points.size === 0) {
      cache.putPriceSeries(token.mint, null);
      return null;
    }
  }

  if (points.size === 0) {
    cache.putPriceSeries(token.mint, null);
    return null;
  }

  const series: PriceSeries = {
    points: [...points.entries()].map(([time, price]) => ({ time, price })).sort((a, b) => a.time - b.time),
    supply,
  };

  cache.putPriceSeries(token.mint, series);
  return series;
}
