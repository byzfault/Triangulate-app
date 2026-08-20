import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError, BudgetExceededError, QuotaExhaustedError, RequestBudget } from '../../shared/client.js';
import { cache } from '../../shared/cache.js';
import { config, filterDefaults, type Filters } from '../../shared/config.js';
import { JobRegistry } from '../../shared/jobs.js';
import type { ProgressEvent, ResultRow, TokenMeta } from '../../shared/types.js';
import { runSearch } from './pipeline.js';
import { deepCheckWallet } from './deepcheck.js';
import { fetchPriceSeries } from './prices.js';
import { scoreWallet } from './scoring/index.js';
import type { PriceSeries } from './scoring/types.js';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const jobs = new JobRegistry<ProgressEvent>();

export function registerTriangulate(app: FastifyInstance) {
  /**
   * Tier-2 deep check for one wallet. Costs API requests, so it runs only when explicitly
   * asked for, never as part of a search.
   */
  app.post<{ Body: { wallet?: string; row?: ResultRow; tokens?: TokenMeta[]; requireProfitOnAll?: boolean } }>(
    '/api/deep-check',
    async (req, reply) => {
      const wallet = typeof req.body?.wallet === 'string' ? req.body.wallet.trim() : '';
      if (!BASE58.test(wallet)) return reply.code(400).send({ error: 'Not a valid Solana wallet address.' });
      if (!config.apiKey) return reply.code(400).send({ error: 'No Solana Tracker API key configured.' });

      const row = req.body?.row;
      const tokens = req.body?.tokens;
      if (!row || !Array.isArray(tokens)) {
        return reply.code(400).send({ error: 'Deep check needs the wallet row from a completed search.' });
      }

      const budget = new RequestBudget();
      try {
        const deep = await deepCheckWallet(wallet, budget);

        const prices = new Map<string, PriceSeries>();
        for (const token of tokens) {
          const series = await fetchPriceSeries(token, budget);
          if (series) prices.set(token.mint, series);
        }

        const score = scoreWallet(row, {
          tokens,
          prices,
          hasWalletData: true,
          requireProfitOnAll: req.body?.requireProfitOnAll ?? true,
          now: Date.now(),
          deep,
        });

        return { wallet, score, requests: budget.requests, cacheHits: budget.cacheHits };
      } catch (err) {
        const message = err instanceof ApiError ? err.message : `Deep check failed: ${(err as Error).message}`;
        app.log.error({ err }, 'deep check failed');
        return reply.code(502).send({ error: message });
      }
    },
  );

  app.post<{ Body: { mints?: unknown; filters?: Partial<Filters>; refresh?: boolean } }>(
    '/api/search',
    async (req, reply) => {
      const raw = Array.isArray(req.body?.mints) ? req.body.mints : [];
      const mints = [...new Set(raw.filter((m): m is string => typeof m === 'string').map((m) => m.trim()))];

      if (mints.length < 2) {
        return reply.code(400).send({ error: 'Enter at least 2 token addresses to triangulate.' });
      }
      if (mints.length > 5) {
        return reply.code(400).send({ error: 'A maximum of 5 token addresses can be searched at once.' });
      }
      const invalid = mints.filter((m) => !BASE58.test(m));
      if (invalid.length > 0) {
        return reply.code(400).send({ error: `Not a valid Solana address: ${invalid.join(', ')}` });
      }
      if (!config.apiKey) {
        return reply.code(400).send({
          error:
            'No Solana Tracker API key configured. Copy .env.example to .env and add SOLANA_TRACKER_API_KEY — a free key is at solanatracker.io/data-api.',
        });
      }

      if (req.body?.refresh) for (const mint of mints) cache.clear(mint);

      const filters: Filters = { ...filterDefaults, ...(req.body?.filters ?? {}) };
      const id = randomUUID();
      const job = jobs.create(id);

      // Deliberately not awaited: the response returns the job id immediately and the client
      // follows progress over SSE.
      void (async () => {
        const budget = new RequestBudget(config.maxRequestsPerQuery, (count) =>
          jobs.publish(job, { type: 'requests', count }),
        );
        try {
          const result = await runSearch(mints, filters, (e) => jobs.publish(job, e), budget);
          app.log.info(
            { requests: budget.requests, cacheHits: budget.cacheHits, rows: result.rows.length },
            'search complete',
          );
          jobs.publish(job, { type: 'done', result });
        } catch (err) {
          const message =
            err instanceof QuotaExhaustedError || err instanceof BudgetExceededError || err instanceof ApiError
              ? err.message
              : `Something went wrong: ${(err as Error).message}`;
          app.log.error({ err }, 'search failed');
          jobs.publish(job, { type: 'error', message });
        } finally {
          jobs.retire(id);
        }
      })();

      return { id };
    },
  );

  app.get<{ Params: { id: string } }>('/api/search/:id/events', (req, reply) => {
    jobs.stream(req.params.id, req, reply, 'That search has expired. Run it again.');
  });
}
