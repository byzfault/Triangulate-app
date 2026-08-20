import { config } from './config.js';
import { nextTier, record } from './usage.js';

/**
 * Errors we surface to the UI in plain language rather than as HTTP noise.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Raised when the monthly free allowance is spent and paid credit is either switched off or
 * also exhausted. Distinct from BudgetExceededError, which is a per-query ceiling: this one
 * means the account itself has nothing left to spend.
 */
export class QuotaExhaustedError extends Error {
  constructor() {
    super(
      'The Solana Tracker free allowance for this period is spent. Enable paid credit in .env ' +
        '(PAID_CREDITS_ENABLED and PAID_CREDIT_LIMIT) to continue, or wait for the monthly reset.',
    );
    this.name = 'QuotaExhaustedError';
  }
}

export class BudgetExceededError extends Error {
  constructor(readonly limit: number) {
    super(`This query hit its ${limit}-request ceiling and stopped early.`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Token bucket shared by every query in the process — the rate limit is per API key,
 * not per query, so two concurrent searches must contend for the same budget.
 */
class RateLimiter {
  private queue: Array<() => void> = [];
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly perSec: number) {
    this.tokens = perSec;
    setInterval(() => this.pump(), 50).unref();
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.perSec, this.tokens + elapsed * this.perSec);
    this.lastRefill = now;
  }

  private pump() {
    this.refill();
    while (this.tokens >= 1 && this.queue.length > 0) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
  }

  acquire(): Promise<void> {
    return new Promise((res) => {
      this.queue.push(res);
      this.pump();
    });
  }
}

const limiter = new RateLimiter(config.rateLimitPerSec);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Counts requests for one query and enforces the per-query ceiling, so a pathologically
 * large token can't quietly drain a month of free-tier quota.
 */
export class RequestBudget {
  requests = 0;
  cacheHits = 0;

  constructor(
    private readonly limit: number = config.maxRequestsPerQuery,
    private readonly onChange?: (count: number) => void,
  ) {}

  spend() {
    if (this.requests >= this.limit) throw new BudgetExceededError(this.limit);
    this.requests += 1;
    this.onChange?.(this.requests);
  }

  hit() {
    this.cacheHits += 1;
  }

  get remaining() {
    return Math.max(0, this.limit - this.requests);
  }
}

const MAX_ATTEMPTS = 5;

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; budget: RequestBudget },
): Promise<T> {
  if (!config.apiKey) {
    throw new ApiError(
      'No Solana Tracker API key configured. Add SOLANA_TRACKER_API_KEY to your .env file — a free key is at solanatracker.io/data-api.',
    );
  }

  const url = new URL(config.baseUrl + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  let lastError: ApiError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    opts.budget.spend();

    // Checked per attempt, not per call: a retry costs another request against the account,
    // so a run that crosses the allowance boundary mid-retry must stop there.
    const tier = nextTier();
    if (tier === null) throw new QuotaExhaustedError();

    await limiter.acquire();

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'x-api-key': config.apiKey,
          accept: 'application/json',
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // Deliberately not recorded: the request never reached Solana Tracker, so it cost
      // nothing on their side and must not count against the allowance. Only responses do.
      lastError = new ApiError(
        `Couldn't reach Solana Tracker (${(err as Error).message}). Check your connection.`,
        undefined,
        true,
      );
      await sleep(backoffMs(attempt));
      continue;
    }

    record('solanatracker', tier, path, res.ok);

    if (res.ok) {
      return (await res.json()) as T;
    }

    // 429 and 5xx are worth retrying; everything else is a permanent answer.
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
      lastError = new ApiError(
        res.status === 429
          ? 'Solana Tracker is rate limiting us. Backing off and retrying.'
          : `Solana Tracker returned a server error (${res.status}).`,
        res.status,
        true,
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(waitMs);
        continue;
      }
    }

    throw new ApiError(await describeFailure(res), res.status);
  }

  throw lastError ?? new ApiError('Request failed after several retries.');
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1));
  return base + Math.random() * 250; // jitter, so parallel retries don't resynchronise
}

async function describeFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    detail = text.slice(0, 300);
  } catch {
    /* body already consumed or unreadable — the status alone will have to do */
  }

  switch (res.status) {
    case 401:
    case 403:
      return 'Solana Tracker rejected the API key. Check SOLANA_TRACKER_API_KEY in your .env.';
    case 404:
      return "Solana Tracker has no data for that token — it may be too new, or the address may not be a token mint.";
    case 402:
      return 'Your Solana Tracker plan is out of requests for this month.';
    default:
      return `Solana Tracker returned ${res.status}. ${detail}`.trim();
  }
}

/**
 * Identical GETs issued while one is already in flight share the same promise, so two
 * searches touching the same mint at once — or a repeated click — cause one upstream call
 * rather than several. Only GETs are deduped: they're the idempotent ones.
 */
const inFlight = new Map<string, Promise<unknown>>();

function dedupedGet<T>(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  budget: RequestBudget,
): Promise<T> {
  const key = path + '?' + JSON.stringify(query);
  const existing = inFlight.get(key);
  if (existing) {
    // The caller that actually issues the request pays for it; followers are cache hits.
    budget.hit();
    return existing as Promise<T>;
  }

  const promise = request<T>('GET', path, { query, budget }).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export const api = {
  get: <T>(path: string, query: Record<string, string | number | boolean | undefined>, budget: RequestBudget) =>
    dedupedGet<T>(path, query, budget),
  post: <T>(
    path: string,
    body: unknown,
    budget: RequestBudget,
    query: Record<string, string | number | boolean | undefined> = {},
  ) => request<T>('POST', path, { body, query, budget }),
};
