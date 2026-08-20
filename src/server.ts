import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config, filterDefaults, type Filters } from './config.js';
import { ApiError, BudgetExceededError, RequestBudget } from './client.js';
import { runSearch } from './pipeline.js';
import { getTrending24h, getTrending7d } from './trending.js';
import { deepCheckWallet } from './deepcheck.js';
import { scoreWallet, scoringConfig } from './scoring/index.js';
import { fetchPriceSeries } from './prices.js';
import type { PriceSeries } from './scoring/types.js';
import type { ResultRow, TokenMeta } from './types.js';
import { cache } from './cache.js';
import type { ProgressEvent } from './types.js';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const app = Fastify({ logger: true });

await app.register(fastifyStatic, {
  root: resolve(process.cwd(), 'public'),
  index: 'index.html',
});

/**
 * A search runs in the background and streams progress over SSE. Jobs are held in memory
 * only — this is a single-user localhost tool, so there's nothing to persist.
 */
interface Job {
  events: ProgressEvent[];
  subscribers: Set<(e: ProgressEvent) => void>;
  finished: boolean;
}

const jobs = new Map<string, Job>();

function publish(job: Job, event: ProgressEvent) {
  job.events.push(event);
  if (event.type === 'done' || event.type === 'error') job.finished = true;
  for (const send of job.subscribers) send(event);
}

app.get('/api/health', async () => ({
  ok: true,
  apiKeyConfigured: config.apiKey.length > 0,
  rateLimitPerSec: config.rateLimitPerSec,
  maxRequestsPerQuery: config.maxRequestsPerQuery,
  cacheTtlHours: config.cacheTtlHours,
  filterDefaults,
  scoringBands: scoringConfig.bands,
}));

app.get('/api/trending', async (_req, reply) => {
  try {
    const h24 = await getTrending24h();
    // The 7-day list never blocks: it returns whatever has been computed so far and
    // reports whether a background refresh is running.
    return { h24, d7: getTrending7d() };
  } catch (err) {
    app.log.warn({ err }, 'trending fetch failed');
    return reply.code(503).send({
      error: "Couldn't load trending tokens right now. The panel will retry on the next refresh.",
    });
  }
});

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
    const job: Job = { events: [], subscribers: new Set(), finished: false };
    jobs.set(id, job);

    // Deliberately not awaited: the response returns the job id immediately and the client
    // follows progress over SSE.
    void (async () => {
      const budget = new RequestBudget(config.maxRequestsPerQuery, (count) =>
        publish(job, { type: 'requests', count }),
      );
      try {
        const result = await runSearch(mints, filters, (e) => publish(job, e), budget);
        app.log.info(
          { requests: budget.requests, cacheHits: budget.cacheHits, rows: result.rows.length },
          'search complete',
        );
        publish(job, { type: 'done', result });
      } catch (err) {
        const message =
          err instanceof BudgetExceededError || err instanceof ApiError
            ? err.message
            : `Something went wrong: ${(err as Error).message}`;
        app.log.error({ err }, 'search failed');
        publish(job, { type: 'error', message });
      } finally {
        // Give a slow client a window to connect and drain before we drop the job.
        setTimeout(() => jobs.delete(id), 120_000).unref();
      }
    })();

    return { id };
  },
);

app.get<{ Params: { id: string } }>('/api/search/:id/events', (req, reply) => {
  const job = jobs.get(req.params.id);
  if (!job) return reply.code(404).send({ error: 'That search has expired. Run it again.' });

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (e: ProgressEvent) => {
    reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    if (e.type === 'done' || e.type === 'error') reply.raw.end();
  };

  // Replay anything that happened before this client connected.
  for (const e of job.events) send(e);
  if (job.finished) return;

  job.subscribers.add(send);
  req.raw.on('close', () => job.subscribers.delete(send));
});

const address = await app.listen({ port: config.port, host: '127.0.0.1' });

if (!config.apiKey) {
  app.log.warn('SOLANA_TRACKER_API_KEY is not set — searches will fail until you add it to .env');
}
app.log.info(`Triangular ready at ${address}`);
