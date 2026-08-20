import { record } from './usage.js';

/**
 * GeckoTerminal: the free tier of the suite.
 *
 * Keyless, unmetered, and billed to nobody, so anything it can answer should never be asked
 * of Solana Tracker. What it can answer is narrow but valuable: the most recent ~300 trades
 * on a pool, each carrying the trading wallet. That is enough to *observe* trading as it
 * happens, and not nearly enough to reconstruct history — there is no cursor, so there is no
 * way to page backwards past the window it offers.
 *
 * That asymmetry is the whole design of the cost model. Recent activity is logged for free,
 * continuously, and accumulates; only history that was never observed has to be bought.
 */
const API = 'https://api.geckoterminal.com/api/v2/networks/solana';

/** GeckoTerminal asks for ~30 calls/minute. One in flight at a time is comfortably inside. */
const MIN_GAP_MS = 2_100;
let lastCall = 0;

async function politeFetch(url: string, endpoint: string): Promise<unknown | null> {
  const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    record('geckoterminal', 'free', endpoint, res.ok);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export interface PoolTrade {
  wallet: string;
  /** 'buy' means the wallet acquired the base token. */
  side: 'buy' | 'sell';
  /** Unix ms. GeckoTerminal reports whole seconds, so this is second-resolution. */
  time: number;
  volumeUsd: number;
  tx: string;
}

/**
 * The most recent trades on one pool. Free, and the backbone of the background logger.
 *
 * `kind` is buy/sell from the pool's perspective, which for a memecoin/SOL pool means buy =
 * someone acquiring the memecoin. That is the direction Copy Tracker cares about.
 */
export async function fetchPoolTrades(pool: string, minVolumeUsd = 0): Promise<PoolTrade[]> {
  const url =
    `${API}/pools/${pool}/trades` +
    (minVolumeUsd > 0 ? `?trade_volume_in_usd_greater_than=${minVolumeUsd}` : '');
  const raw = (await politeFetch(url, '/pools/{address}/trades')) as
    | { data?: Array<{ attributes?: Record<string, unknown> }> }
    | null;
  if (!raw?.data) return [];

  const out: PoolTrade[] = [];
  for (const entry of raw.data) {
    const a = entry.attributes ?? {};
    const wallet = typeof a.tx_from_address === 'string' ? a.tx_from_address : null;
    const kind = typeof a.kind === 'string' ? a.kind : null;
    const stamp = typeof a.block_timestamp === 'string' ? Date.parse(a.block_timestamp) : NaN;
    if (!wallet || (kind !== 'buy' && kind !== 'sell') || !Number.isFinite(stamp)) continue;

    out.push({
      wallet,
      side: kind,
      time: stamp,
      volumeUsd: Number(a.volume_in_usd) || 0,
      tx: typeof a.tx_hash === 'string' ? a.tx_hash : '',
    });
  }
  return out;
}

/** The pools backing a token, most liquid first — needed to know what to poll. */
export async function fetchTokenPools(mint: string): Promise<string[]> {
  const raw = (await politeFetch(`${API}/tokens/${mint}/pools`, '/tokens/{address}/pools')) as
    | { data?: Array<{ attributes?: { address?: string; reserve_in_usd?: string } }> }
    | null;
  if (!raw?.data) return [];

  return raw.data
    .map((d) => ({
      address: d.attributes?.address,
      reserve: Number(d.attributes?.reserve_in_usd) || 0,
    }))
    .filter((p): p is { address: string; reserve: number } => typeof p.address === 'string')
    .sort((a, b) => b.reserve - a.reserve)
    .map((p) => p.address);
}
