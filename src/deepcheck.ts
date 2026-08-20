import { api, type RequestBudget } from './client.js';
import { cache } from './cache.js';
import type { DeepCheckData } from './scoring/types.js';

/**
 * Tier-2: the wallet's own trade history, across every token it has touched.
 *
 * `/wallet/{wallet}/trades` returns 1,000 trades per page, so most wallets cost one or two
 * requests — cheap enough to run per wallet on demand, and the only way to get the per-trade
 * timestamps that human-cadence scoring needs. Never called automatically.
 *
 * The result is cached indefinitely: past trades don't change. Only the tail can be stale,
 * and the cadence and breadth signals derived here are not sensitive to the last few hours.
 */
const PAGE_LIMIT = 6; // 6,000 trades is plenty to characterise a wallet's rhythm

interface TradesResponse {
  trades?: Array<{ time?: number; from?: { address?: string }; to?: { address?: string } }>;
  nextCursor?: number | string;
  hasNextPage?: boolean;
}

export async function deepCheckWallet(wallet: string, budget: RequestBudget): Promise<DeepCheckData> {
  const cached = cache.getDeepCheck(wallet);
  if (cached) {
    budget.hit();
    return cached;
  }

  const tradeTimes: number[] = [];
  const tokens = new Set<string>();
  let cursor: string | number | undefined;

  for (let page = 0; page < PAGE_LIMIT; page++) {
    const raw = await api.get<TradesResponse>(
      `/wallet/${wallet}/trades`,
      { cursor, sortDirection: 'DESC' },
      budget,
    );

    const trades = raw?.trades ?? [];
    if (trades.length === 0) break;

    for (const t of trades) {
      const time = typeof t.time === 'number' ? (t.time < 1e12 ? t.time * 1000 : t.time) : null;
      if (time !== null) tradeTimes.push(time);
      // Each trade names both sides; whichever isn't SOL/USDC is the token traded.
      for (const addr of [t.from?.address, t.to?.address]) {
        if (addr && !QUOTE_MINTS.has(addr)) tokens.add(addr);
      }
    }

    if (!raw.hasNextPage || raw.nextCursor === undefined || raw.nextCursor === cursor) break;
    cursor = raw.nextCursor;
  }

  const data: DeepCheckData = {
    wallet,
    tradeTimes,
    tokensTraded: tokens.size,
    // The trades feed carries no per-trade PnL, so wallet-wide profitable-token counts still
    // come from the track-record call rather than being recomputed here.
    profitableTokens: null,
    fetchedAt: Date.now(),
  };

  cache.putDeepCheck(wallet, data);
  return data;
}

const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
