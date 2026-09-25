/** Midnight in Harare (UTC+2, no daylight saving) for the given moment. */
export function harareStartOfDay(now: Date): Date {
  const local = new Date(now.getTime() + 2 * 3600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 2 * 3600_000);
}
