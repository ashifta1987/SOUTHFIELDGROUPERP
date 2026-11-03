// Retry schedule for outbound integration calls. Mirrors app.integration_backoff_seconds in Postgres
// (20261103008100_integrations_api.sql): wait = base × 2^(attempts − 1), capped at max. Attempts count from 1.

export function backoffSeconds(attempts: number, baseSeconds: number, maxSeconds: number): number {
  const a = Math.max(Math.min(Math.floor(attempts), 31), 1)
  return Math.min(maxSeconds, baseSeconds * 2 ** (a - 1))
}

/** The waits after each failed attempt until the request is dead-lettered (the last attempt has no wait). */
export function backoffSchedule(maxAttempts: number, baseSeconds: number, maxSeconds: number): number[] {
  const out: number[] = []
  for (let a = 1; a < maxAttempts; a++) out.push(backoffSeconds(a, baseSeconds, maxSeconds))
  return out
}

/** Dead letter when the attempt that just failed was the last allowed one, or the error is not retryable. */
export function shouldDeadLetter(attempts: number, maxAttempts: number, retryable: boolean): boolean {
  return !retryable || attempts >= maxAttempts
}
