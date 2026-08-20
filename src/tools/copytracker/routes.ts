import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError, BudgetExceededError, QuotaExhaustedError, RequestBudget } from '../../shared/client.js';
import { config } from '../../shared/config.js';
import { JobRegistry } from '../../shared/jobs.js';
import { runTrace, traceDefaults, type TraceOptions } from './trace.js';
import { confidenceConfig, rankCandidates } from './confidence.js';
import { cachedProfile } from '../../shared/walletProfile.js';
import { loggerStatus, startLogger, stopLogger, trackToken } from './logger.js';
import { store } from './store.js';
import type { TraceProgress } from './types.js';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const jobs = new JobRegistry<TraceProgress>();

export function registerCopyTracker(app: FastifyInstance) {
  app.get('/api/copy/config', async () => ({
    defaults: traceDefaults,
    bands: confidenceConfig.bands,
    followers: store.listFollowers(),
    logger: loggerStatus(),
  }));

  /**
   * The sources already established for a wallet, recomputed from the stored log with no
   * API calls at all. Selecting a saved wallet shows its shortlist immediately, rather than
   * making you re-run a trace to see what you already know.
   */
  app.get<{ Params: { follower: string }; Querystring: { minHits?: string; minTokens?: string; excludeBots?: string } }>(
    '/api/copy/candidates/:follower',
    async (req, reply) => {
      const follower = req.params.follower.trim();
      if (!BASE58.test(follower)) return reply.code(400).send({ error: 'Not a valid wallet address.' });

      const history = store.history(follower);
      const ranked = rankCandidates(history.observations, history.events, {
        minHits: clampNum(req.query.minHits, 1, 50, traceDefaults.minHits),
        minTokens: clampNum(req.query.minTokens, 1, 8, traceDefaults.minTokens),
        excludeBots: req.query.excludeBots !== 'false',
      });

      // Verdicts already paid for are reused here, so a wallet unmasked as a bot on a
      // previous run stays off the list without another request.
      const excludeBots = req.query.excludeBots !== 'false';
      const withProfiles = ranked.candidates.map((c) => {
        const p = cachedProfile(c.wallet);
        return p
          ? {
              ...c,
              profile: {
                tradesPerDay: Math.round(p.tradesPerDay),
                distinctTokens: p.distinctTokens,
                isBot: p.isBot,
                reason: p.reason,
              },
            }
          : c;
      });
      const visible = excludeBots ? withProfiles.filter((c) => !c.profile?.isBot) : withProfiles;

      return {
        follower,
        label: store.listFollowers().find((f) => f.follower === follower)?.label ?? null,
        candidates: visible,
        knownBots: withProfiles.filter((c) => c.profile?.isBot).length,
        considered: ranked.considered,
        botsExcluded: ranked.botsExcluded,
        events: history.events.length,
        tokens: new Set(history.events.map((e) => e.mint)).size,
      };
    },
  );

  /** The wallets under investigation, for the dropdown. */
  app.get('/api/copy/followers', async () => ({ followers: store.listFollowers() }));

  /** Name or rename a wallet, so a long-running investigation is recognisable. */
  app.post<{ Body: { follower?: string; label?: string } }>('/api/copy/followers', async (req, reply) => {
    const follower = typeof req.body?.follower === 'string' ? req.body.follower.trim() : '';
    if (!BASE58.test(follower)) return reply.code(400).send({ error: 'Not a valid wallet address.' });
    store.saveFollower(follower, typeof req.body?.label === 'string' ? req.body.label : null);
    return { followers: store.listFollowers() };
  });

  app.post<{
    Body: { follower?: string; mints?: unknown; options?: Partial<TraceOptions>; label?: string };
  }>('/api/copy/trace', async (req, reply) => {
    const follower = typeof req.body?.follower === 'string' ? req.body.follower.trim() : '';
    if (!BASE58.test(follower)) {
      return reply.code(400).send({ error: 'Enter a valid Solana wallet address to trace.' });
    }

    const raw = Array.isArray(req.body?.mints) ? req.body.mints : [];
    const mints = [...new Set(raw.filter((m): m is string => typeof m === 'string').map((m) => m.trim()))].filter(
      (m) => m.length > 0,
    );

    if (mints.length < 2) {
      return reply.code(400).send({
        error: 'Enter at least 2 tokens this wallet bought. One token can only ever produce coincidences.',
      });
    }
    if (mints.length > 8) {
      return reply.code(400).send({ error: 'A maximum of 8 tokens can be traced at once.' });
    }
    const invalid = mints.filter((m) => !BASE58.test(m));
    if (invalid.length > 0) {
      return reply.code(400).send({ error: `Not a valid Solana address: ${invalid.join(', ')}` });
    }
    if (mints.includes(follower)) {
      return reply.code(400).send({ error: 'One of the token addresses is the wallet address.' });
    }
    if (!config.apiKey) {
      return reply.code(400).send({
        error:
          'No Solana Tracker API key configured. Copy .env.example to .env and add SOLANA_TRACKER_API_KEY — a free key is at solanatracker.io/data-api.',
      });
    }

    const options: TraceOptions = { ...traceDefaults, ...(req.body?.options ?? {}) };
    options.windowSecs = clampNum(options.windowSecs, 2, 600, traceDefaults.windowSecs);
    options.minHits = clampNum(options.minHits, 1, 50, traceDefaults.minHits);
    options.minTokens = clampNum(options.minTokens, 1, 8, traceDefaults.minTokens);
    options.excludeBots = req.body?.options?.excludeBots !== false;
    options.verifyCandidates = req.body?.options?.verifyCandidates !== false;
    options.firstBuyOnly = req.body?.options?.firstBuyOnly === true;
    options.maxEvents = clampNum(options.maxEvents, 2, 200, traceDefaults.maxEvents);
    options.maxVerifications = clampNum(options.maxVerifications, 0, 50, traceDefaults.maxVerifications);

    // Recorded before the trace runs, so the wallet appears in the dropdown even if the
    // trace then fails — the investigation exists from the moment it is started.
    store.saveFollower(follower, typeof req.body?.label === 'string' ? req.body.label : null);
    store.markTraced(follower);

    const id = randomUUID();
    const job = jobs.create(id);

    void (async () => {
      const budget = new RequestBudget(config.maxRequestsPerQuery, (count) =>
        jobs.publish(job, { type: 'requests', count }),
      );
      try {
        const result = await runTrace(follower, mints, options, (e) => jobs.publish(job, e), budget);
        app.log.info(
          { requests: budget.requests, candidates: result.candidates.length },
          'copy trace complete',
        );
        jobs.publish(job, { type: 'done', result });
      } catch (err) {
        const message =
          err instanceof QuotaExhaustedError || err instanceof BudgetExceededError || err instanceof ApiError
            ? err.message
            : `Something went wrong: ${(err as Error).message}`;
        app.log.error({ err }, 'copy trace failed');
        jobs.publish(job, { type: 'error', message });
      } finally {
        jobs.retire(id);
      }
    })();

    return { id };
  });

  app.get<{ Params: { id: string } }>('/api/copy/trace/:id/events', (req, reply) => {
    jobs.stream(req.params.id, req, reply, 'That trace has expired. Run it again.');
  });

  /** Wipes the accumulated log for one wallet, for when a trace was run against bad input. */
  app.post<{ Body: { follower?: string } }>('/api/copy/forget', async (req, reply) => {
    const follower = typeof req.body?.follower === 'string' ? req.body.follower.trim() : '';
    if (!BASE58.test(follower)) return reply.code(400).send({ error: 'Not a valid wallet address.' });
    const removed = store.forgetFollower(follower);
    return { follower, removed };
  });

  // --- free background logger ------------------------------------------------------------

  app.get('/api/copy/logger', async () => loggerStatus());

  app.post<{ Body: { mint?: string; symbol?: string } }>('/api/copy/logger/track', async (req, reply) => {
    const mint = typeof req.body?.mint === 'string' ? req.body.mint.trim() : '';
    if (!BASE58.test(mint)) return reply.code(400).send({ error: 'Not a valid token mint address.' });
    try {
      const pool = await trackToken(mint, req.body?.symbol ?? null);
      startLogger();
      if (!pool) {
        return reply.code(404).send({ error: 'No GeckoTerminal pool found for that token, so it cannot be watched for free.' });
      }
      return { mint, pool, logger: loggerStatus() };
    } catch (err) {
      return reply.code(502).send({ error: `Couldn't start watching that token: ${(err as Error).message}` });
    }
  });

  app.post<{ Body: { mint?: string } }>('/api/copy/logger/untrack', async (req, reply) => {
    const mint = typeof req.body?.mint === 'string' ? req.body.mint.trim() : '';
    if (!BASE58.test(mint)) return reply.code(400).send({ error: 'Not a valid token mint address.' });
    store.untrack(mint);
    return { mint, logger: loggerStatus() };
  });

  app.post<{ Body: { on?: boolean } }>('/api/copy/logger/toggle', async (req) => {
    if (req.body?.on === false) stopLogger();
    else startLogger();
    return loggerStatus();
  });
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
