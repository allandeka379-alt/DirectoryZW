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

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

const MAX_ATTEMPTS = 3;

/** Durable jobs stored in Postgres (follow-ups, reminders). Works with PGlite and Postgres. */
export class JobQueue {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async enqueue(kind: string, payload: Record<string, unknown>, runAt: Date): Promise<string> {
    const rows = await this.db.query<{ id: string }>(
      "INSERT INTO jobs (kind, payload, run_at) VALUES ($1, $2, $3) RETURNING id",
      [kind, JSON.stringify(payload), runAt],
    );
    return rows[0]!.id;
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
        await handler(job.payload);
        await this.db.query("UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1", [job.id]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retry = job.attempts < MAX_ATTEMPTS;
        await this.db.query("UPDATE jobs SET status = $2, last_error = $3, run_at = $4 WHERE id = $1", [
          job.id,
          retry ? "queued" : "failed",
          message.slice(0, 1000),
          new Date(this.now().getTime() + job.attempts * 5 * 60_000),
        ]);
        this.log.error({ jobId: job.id, kind: job.kind, err: message, retry }, "Job failed");
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
