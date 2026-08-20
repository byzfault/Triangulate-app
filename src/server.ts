import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { config, filterDefaults } from './shared/config.js';
import { getTrending24h, getTrending7d } from './shared/trending.js';
import { summary as usageSummary } from './shared/usage.js';
import { scoringConfig } from './tools/triangulate/scoring/index.js';
import { registerTriangulate } from './tools/triangulate/routes.js';
import { registerCopyTracker } from './tools/copytracker/routes.js';
import { startLogger } from './tools/copytracker/logger.js';
import { store } from './tools/copytracker/store.js';

/**
 * The suite's single server. Each tool registers its own routes and owns its own page under
 * public/; everything here is either shared between them or about the suite as a whole.
 */
const app = Fastify({ logger: true });

await app.register(fastifyStatic, {
  root: resolve(process.cwd(), 'public'),
  index: 'index.html',
});

// --- suite-level routes -----------------------------------------------------------------

app.get('/api/health', async () => ({
  ok: true,
  apiKeyConfigured: config.apiKey.length > 0,
  rateLimitPerSec: config.rateLimitPerSec,
  maxRequestsPerQuery: config.maxRequestsPerQuery,
  cacheTtlHours: config.cacheTtlHours,
  filterDefaults,
  scoringBands: scoringConfig.bands,
}));

/** Trending is shared: Triangulate seeds searches from it, Copy Tracker picks tokens from it. */
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

/** What the suite has spent, across free, quota and paid tiers. */
app.get('/api/usage', async () => ({
  ...usageSummary(),
  copyLog: store.logStats(),
}));

registerTriangulate(app);
registerCopyTracker(app);

// --- pages ------------------------------------------------------------------------------

app.get('/', async (_req, reply) => reply.redirect('/triangulate/'));
for (const [route, file] of [
  ['/triangulate/', 'triangulate/index.html'],
  ['/copy-tracker/', 'copytracker/index.html'],
  ['/usage/', 'usage/index.html'],
] as const) {
  app.get(route, async (_req, reply) => reply.sendFile(file));
}

const address = await app.listen({ port: config.port, host: '127.0.0.1' });

if (!config.apiKey) {
  app.log.warn('SOLANA_TRACKER_API_KEY is not set — searches will fail until you add it to .env');
}

// The free logger only does anything when tokens are being tracked, so starting it here
// costs nothing on a fresh install and means a tracked token survives a restart.
if (store.tracked().length > 0) {
  startLogger();
  app.log.info(`Free trade logger watching ${store.tracked().length} token(s)`);
}

app.log.info(`Solana Toolkit ready at ${address}`);
