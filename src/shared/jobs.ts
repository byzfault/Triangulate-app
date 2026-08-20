import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Background jobs streamed to the browser over SSE.
 *
 * Both tools work the same way: the POST that starts the work returns an id immediately and
 * the client follows progress on an event stream, because a trace or a search takes long
 * enough that a plain request would sit there looking broken. Extracted here so the second
 * tool didn't reimplement the replay-and-subscribe logic the first one already had.
 *
 * Jobs live in memory only. This is a single-user localhost suite, so a restart losing an
 * in-flight search is not worth a persistence layer.
 */
export interface Job<E> {
  events: E[];
  subscribers: Set<(e: E) => void>;
  finished: boolean;
}

export class JobRegistry<E extends { type: string }> {
  private jobs = new Map<string, Job<E>>();

  constructor(private readonly retainMs = 120_000) {}

  create(id: string): Job<E> {
    const job: Job<E> = { events: [], subscribers: new Set(), finished: false };
    this.jobs.set(id, job);
    return job;
  }

  publish(job: Job<E>, event: E) {
    job.events.push(event);
    if (event.type === 'done' || event.type === 'error') job.finished = true;
    for (const send of job.subscribers) send(event);
  }

  /** Keeps the job around briefly so a slow client can still connect and drain it. */
  retire(id: string) {
    setTimeout(() => this.jobs.delete(id), this.retainMs).unref();
  }

  /**
   * Attaches an SSE stream to a job, replaying anything that happened before the client
   * connected so no early progress event is missed.
   */
  stream(id: string, req: FastifyRequest, reply: FastifyReply, notFound: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      void reply.code(404).send({ error: notFound });
      return;
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const send = (e: E) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.type === 'done' || e.type === 'error') reply.raw.end();
    };

    for (const e of job.events) send(e);
    if (job.finished) return;

    job.subscribers.add(send);
    req.raw.on('close', () => job.subscribers.delete(send));
  }
}
