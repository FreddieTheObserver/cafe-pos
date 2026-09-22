# Phase 7, slice 2 - retention jobs

**Date:** 2026-09-22
**Status:** implemented on `phase7-retention`
**Branch:** `phase7-retention`, stacked on `phase7-metrics`
**Scope:** the four §7.5 retention jobs, a gauge that shows whether each is keeping up, and the alert on it.

## Why this slice exists

§7.5 sets four retention windows and §16 asks for the jobs to be "running and observed".
None of the jobs exist.
Customer names, webhook payloads that can carry gateway PII, spent refresh tokens and idempotency keys all accumulate forever today.

## Decisions

### 1. Observed by what is overdue, not by whether a job ran

A "last successful run" timestamp lives in process memory, so every deploy resets it, and a monthly job would go unobserved for up to a month after one.
Instead a scrape-time gauge counts the rows that are past their retention window plus a grace period: `retention_overdue_rows{data}`.
It answers the question §16 actually asks, "is the retention policy being met?", from the data itself.
It survives restarts, it notices a job that is failing, and it notices one that was never scheduled.

The grace period is the job's cadence plus a margin: two days for the nightly jobs and two hours for the hourly one.
An alert, `RetentionBehind`, notifies when any count stays above zero for an hour.

### 2. Payloads are trimmed nightly, not monthly

§7.5 says monthly.
A nightly run is strictly better here: each run is small, a missed night is caught up the next, and the overdue gauge can use a two-day grace instead of a month.
The retention window itself, thirteen months, is unchanged.

### 3. A trimmed payload is marked by a column, not by its shape

Migration `0007` adds `payment_events.payload_trimmed_at`.
The alternative, recognising a trimmed payload by which keys it has left, would tie the job's idempotency to the JSON's shape.
The column also records when the PII was removed, and a partial index on `received_at` for untrimmed rows keeps both the job and the gauge off a full scan of an inbox that grows for five years.

A trimmed payload keeps what identifies the event and nothing else: `{ id, type, created, data: { object: { id } } }`.

### 4. Every job is one guarded statement, run in bounded batches

Each job updates or deletes by primary key from a `LIMIT`ed subquery, repeated until a batch comes back short, up to a cap per run.
The `WHERE` clause is the whole policy, so running a job twice, or on two instances at once, changes nothing the second time.
The batch loop is a pure function, unit-tested with a fake step.

### 5. Scheduled in the dead zone

The nightly jobs run at 04:00 Asia/Bangkok, after the 03:00 rollup and reconciliation and before the 05:00 business-day boundary.
Idempotency keys are cleared hourly, at 17 minutes past, so their 24-hour window is met within the hour.

| Data | Window | Job | Grace in the gauge |
|---|---|---|---|
| `orders.customer_name` | 90 days from `created_at` | nightly, set to NULL | 2 days |
| `payment_events.payload` | 13 months from `received_at` | nightly, trimmed | 2 days |
| `refresh_tokens` | 30 days after `expires_at` or `revoked_at` | nightly, deleted | 2 days |
| `idempotency_keys` | past `expires_at` (24 hours) | hourly, deleted | 2 hours |

`retention_rows_total{data}` counts the rows each job handled, for the dashboard.

## Testing

- **The batch loop** (unit): stops on a short batch, keeps going on a full one, stops at the cap, and returns the total.
- **Each job** (e2e, against Postgres): a row just past the window is handled, a row just inside it is not, and a second run changes nothing.
  Each fixture sits on the boundary it tests, so a job with the window off by a day fails.
  Ages are set relative to the database clock, the same clock the jobs read.
- **The gauge** (e2e): after a job has run, its count is zero; a row inserted past window plus grace raises it.
- **The rule** (promtool): fires after an hour above zero, not before, and not at zero.
- **Falsification:** dropping each job's age condition, and each job's "already done" condition, must turn a test red.

## Out of scope

- Backups and point-in-time recovery, which are deployment.
- The five-year retention of orders and payments, which needs no job until year six.
