import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";

export interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  run_at: Date;
  status: string;
  attempts: number;
}

export type JobHandler = (payload: Record<string, unknown>, job: Job) => Promise<void>;

/** A job is tried this many times, a few minutes apart, before it is marked failed. */
export const MAX_JOB_ATTEMPTS = 3;

/** Durable jobs stored in Postgres (follow-ups, reminders). Works with PGlite and Postgres. */
export class JobQueue {
  private waker?: (runAt: Date) => void;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
    /** Called when a job fails for the last time. */
    private readonly onFailed?: (job: Job, error: string) => void,
  ) {}

  /** Told when a job is queued to run within the minute, so it can start then rather than at the next tick. */
  onSoon(fn: (runAt: Date) => void): void {
    this.waker = fn;
  }

  async enqueue(kind: string, payload: Record<string, unknown>, runAt: Date): Promise<string> {
    const rows = await this.db.query<{ id: string }>(
      "INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, $3) RETURNING id",
      [kind, JSON.stringify(payload), runAt],
    );
    if (runAt.getTime() - this.now().getTime() < 60_000) this.waker?.(runAt);
    return rows[0]!.id;
  }

  /**
   * Queue a job unless one of the same kind and key is already waiting. Many quick changes (a bulk
   * upload, prices typed one after another) make one run, which picks up everything that changed.
   */
  async enqueueOnce(kind: string, key: string, payload: Record<string, unknown>, runAt: Date): Promise<boolean> {
    const waiting = await this.db.query("SELECT 1 FROM jobs WHERE kind = $1 AND status = 'queued' AND payload->>'key' = $2 LIMIT 1", [kind, key]);
    if (waiting.length) return false;
    await this.enqueue(kind, { ...payload, key }, runAt);
    return true;
  }

  /** Run every job that is due. Returns how many were attempted. */
  async runDue(handlers: Record<string, JobHandler>, limit = 20): Promise<number> {
    const jobs = await this.db.query<Job>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1
        WHERE id IN (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= $1
                     ORDER BY run_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [this.now(), limit],
    );
    for (const job of jobs) {
      const handler = handlers[job.kind];
      try {
        if (!handler) throw new Error(`No handler for job kind ${job.kind}`);
        await handler(job.payload, job);
        await this.db.query("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1", [job.id]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retry = job.attempts < MAX_JOB_ATTEMPTS;
        await this.db.query("UPDATE jobs SET status = $2, last_error = $3, run_at = $4 WHERE id = $1", [
          job.id,
          retry ? "queued" : "failed",
          message.slice(0, 1000),
          new Date(this.now().getTime() + job.attempts * 5 * 60_000),
        ]);
        this.log.error({ jobId: job.id, kind: job.kind, err: message, retry }, "Job failed");
        if (!retry) this.onFailed?.(job, message);
      }
    }
    return jobs.length;
  }

  /** After a crash, put jobs left "running" for over 10 minutes back in the queue. */
  async recoverStuck(): Promise<void> {
    await this.db.query(
      "UPDATE jobs SET status = 'queued' WHERE status = 'running' AND run_at < $1",
      [new Date(this.now().getTime() - 10 * 60_000)],
    );
  }
}
