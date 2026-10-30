/**
 * §7.5's retention windows, and the grace the overdue gauge allows each job
 * before a row counts as missed: the job's cadence plus a margin.
 *
 * Intervals are Postgres interval literals, bound as parameters, so the jobs
 * and the gauge compare against the database's clock with the same numbers.
 */
export const RETENTION = {
  customer_names: { window: '90 days', grace: '2 days' },
  event_payloads: { window: '13 months', grace: '2 days' },
  refresh_tokens: { window: '30 days', grace: '2 days' },
  idempotency_keys: { window: '0 seconds', grace: '2 hours' },
} as const;

export type RetainedData = keyof typeof RETENTION;

export const RETAINED_DATA = Object.keys(RETENTION) as RetainedData[];
