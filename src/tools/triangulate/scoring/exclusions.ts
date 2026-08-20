import type { ResultRow } from '../../../shared/types.js';
import type { ScoringContext } from './types.js';
import type { ScoringConfig } from './config.js';
import { median } from './util.js';

/**
 * Hard gates. These run before scoring and reject outright — a wallet failing one is never
 * shown a numeric score, because the disqualifying trait isn't something good behaviour
 * elsewhere should be able to outweigh.
 *
 * Returns a human-readable reason, or null when the wallet passes.
 */
export function checkExclusions(row: ResultRow, ctx: ScoringContext, cfg: ScoringConfig): string | null {
  const c = cfg.exclusions;

  // --- Sniper -------------------------------------------------------------------------
  // Median rather than minimum, so one fast entry among several patient ones doesn't
  // condemn the wallet. Tokens whose history predates the provider's index are skipped:
  // their launch time isn't real, so timing against it would be meaningless.
  const entrySecs = ctx.tokens
    .filter((t) => !t.historyTruncated)
    .map((t) => row.perToken[t.mint]?.hoursAfterLaunch)
    .filter((h): h is number => typeof h === 'number' && Number.isFinite(h) && h >= 0)
    .map((h) => h * 3600);

  const medianEntry = median(entrySecs);
  if (medianEntry !== null && medianEntry < c.sniperSecs) {
    return `Sniper: median first buy ${Math.round(medianEntry)}s after launch (under ${c.sniperSecs}s).`;
  }

  // --- Transfer-inflated PnL ----------------------------------------------------------
  // Selling materially more than was bought through swaps means the tokens arrived some
  // other way — a transfer or airdrop — so there's no genuine cost basis and the realized
  // figure is inflated.
  for (const token of ctx.tokens) {
    const pos = row.perToken[token.mint];
    if (!pos) continue;

    if (pos.sells > 0 && pos.buys === 0) {
      const sym = token.symbol;
      return `Transfer-inflated: sold ${sym} with no swap buys, so the cost basis isn't real.`;
    }

    const bought = pos.tokensBought;
    const sold = pos.tokensSold;
    if (bought !== null && sold !== null && bought > 0 && sold > bought * (1 + c.transferInflationTolerance)) {
      const excess = ((sold / bought - 1) * 100).toFixed(0);
      return `Transfer-inflated: sold ${excess}% more ${token.symbol} than was ever bought via swaps.`;
    }
  }

  // --- Deployer -----------------------------------------------------------------------
  // Deployer-funded wallets would need the funding source, which this data source doesn't
  // expose, so only the deployer itself is caught here.
  if (c.excludeDeployers && row.flags.deployer) {
    return 'Deployer: this wallet deployed one of the queried tokens.';
  }

  return null;
}
