/** A wallet's position in one token, normalised from Solana Tracker's response shapes. */
export interface Position {
  wallet: string;
  mint: string;
  realized: number;
  unrealized: number;
  invested: number;
  proceeds: number;
  /** Return on investment for this position, as a percentage. 1,500% = a 16x. */
  roi: number | null;
  buys: number;
  sells: number;
  /** Remaining token balance, in whole tokens. */
  balance: number;
  /** Unix ms, or null when the provider didn't report it. */
  firstBuy: number | null;
  firstTrade: number | null;
  lastTrade: number | null;
  holdTimeSecs: number | null;
  /** Raw token amounts, used to detect PnL inflated by transfers rather than swap buys. */
  tokensBought: number | null;
  tokensSold: number | null;
  /**
   * Wallet-wide lifetime trade count. Only the /traders endpoint carries it, so it's
   * populated for anchor wallets and absent from batch lookups.
   */
  walletLifetimeTrades: number | null;
  identityType: string | null;
  isArbitrage: boolean;
}

/** A wallet's lifetime record across every token it has traded. */
export interface TrackRecord {
  winRate: number | null;
  closedPositions: number | null;
  avgHoldSecs: number | null;
  /** Wallet-wide ROI percentage across every token traded. */
  roi: number | null;
  avgPnlPerAsset: number | null;
  /** Share of closed positions that returned over 200%. */
  bigWinRate: number | null;
}

export interface TokenMeta {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Earliest pool creation across all pools — our reference for "first pool trade". */
  firstPoolAt: number | null;
  deployers: string[];
  /**
   * Size proxies used only to pick the anchor token. The traders endpoint's
   * `pagination.total` reports the page size, not a global count, so it can't be used.
   */
  holders: number | null;
  txnsTotal: number | null;
  /**
   * Launch time derived from the earliest credible first-buy we observed, rather than from
   * pool `createdAt` — many pools omit it, and the earliest that reports one is often not
   * the original pool.
   */
  launchAt: number | null;
  launchSource: 'observed' | 'pool' | 'none';
  /**
   * True when the token predates the provider's PnL index, so its early history — and part
   * of its realized PnL — simply isn't in the data. Timing filters are skipped for these.
   */
  historyTruncated: boolean;
}

export interface ResultRow {
  wallet: string;
  combinedRealized: number;
  combinedUnrealized: number;
  totalBuys: number;
  totalSells: number;
  profitableTokens: number;
  /** Wallet-wide trades in the activity window; null when the check didn't run. */
  tradesInWindow: number | null;
  walletLifetimeTrades: number | null;
  /** Wallet-wide track record across every token it has traded, not just the queried ones. */
  winRate: number | null;
  closedPositions: number | null;
  avgHoldSecs: number | null;
  walletRoi: number | null;
  avgPnlPerAsset: number | null;
  bigWinRate: number | null;
  /** Longest hold across the queried tokens, in seconds. */
  maxHoldSecs: number | null;
  /** Best and median ROI across the queried tokens — the multiple, not the dollar amount. */
  bestRoi: number | null;
  medianRoi: number | null;
  totalInvested: number;
  perToken: Record<string, {
    realized: number;
    unrealized: number;
    buys: number;
    sells: number;
    balance: number;
    /** Hours between the token's derived launch and this wallet's first buy. */
    roi: number | null;
    invested: number;
    proceeds: number;
    hoursAfterLaunch: number | null;
    holdTimeSecs: number | null;
    lastTradeAt: number | null;
    tokensBought: number | null;
    tokensSold: number | null;
  }>;
  flags: {
    sniper: boolean;
    deployer: boolean;
    bot: boolean;
  };
  /** Filled in by the scoring pass; null if scoring was skipped. */
  score: import('./scoring/types.js').ScoreBreakdown | null;
}

export interface TrendingToken {
  mint: string;
  name: string;
  symbol: string;
  volume24h: number | null;
  priceChange24h: number | null;
  marketCap: number | null;
}

export interface SearchWarning {
  kind: 'capped' | 'partial' | 'notice';
  message: string;
}

export interface SearchResult {
  mints: string[];
  tokens: TokenMeta[];
  rows: ResultRow[];
  warnings: SearchWarning[];
  stats: {
    requests: number;
    cacheHits: number;
    anchorMint: string;
    anchorWallets: number;
    intersectionSize: number;
    activityChecked: number;
    afterFilters: number;
    elapsedMs: number;
  };
}

export type ProgressEvent =
  | { type: 'phase'; mint: string | null; phase: string; detail?: string }
  | { type: 'requests'; count: number }
  | { type: 'warning'; warning: SearchWarning }
  | { type: 'done'; result: SearchResult }
  | { type: 'error'; message: string };
