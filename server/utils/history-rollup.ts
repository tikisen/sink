import type { AnalyticsFetcher, HistoryDimensionRow } from './history-analytics'
import { and, eq, like } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { clickHistory } from '../database/schema'
import {
  createAnalyticsFetcher,
  fetchHistoryDimension,
  HISTORY_DIMS,
  unixRangeForCentralDay,
} from './history-analytics'

/**
 * Analytics Engine access config, always passed explicitly by the caller
 * (server/plugins/backup.ts's scheduled hook, server/api/history/rollup.post.ts)
 * rather than read here via a bare `useRuntimeConfig()`. That call is only
 * reliable inside Nitro's own request/scheduled-event dispatch — calling
 * rollupHistory directly (as every test here does) runs outside that
 * dispatch, where the auto-imported `useRuntimeConfig` global does not exist
 * at all (confirmed while writing the F21 tests: a bare call threw
 * `ReferenceError: useRuntimeConfig is not defined`). Requiring the config
 * as a parameter makes every call site explicit and makes this function a
 * pure function of its arguments.
 */
export interface RollupHistoryConfig {
  dataset: string
  cfAccountId: string
  cfApiToken: string
}

export interface RollupHistoryOptions {
  /** Overrides the real Cloudflare Analytics Engine call — used by tests. */
  fetcher?: AnalyticsFetcher
}

export interface RollupHistoryResult {
  day: string
  rows: number
}

type NewClickHistoryRow = typeof clickHistory.$inferInsert

const STAGE_INSERT_CHUNK = 50
const STAGING_SOURCE_PREFIX = 'sink-staging:'

/**
 * A link_id can appear more than once per dimension query if its slug changed
 * mid-day (blob1 is part of the GROUP BY for display, but the table's primary
 * key is linkId+day+dim+value+source, which does not include slug). Merge
 * those into one row — summed clicks, latest slug wins — before writing, so
 * the swap batch never sees two rows for the same primary key.
 */
function mergeByPrimaryKey(rows: Array<HistoryDimensionRow & { dim: string }>, day: string): NewClickHistoryRow[] {
  const merged = new Map<string, NewClickHistoryRow>()
  for (const row of rows) {
    const key = `${row.linkId}\u0000${row.dim}\u0000${row.value}`
    const existing = merged.get(key)
    if (existing) {
      existing.clicks += row.clicks
      if (row.slug)
        existing.slug = row.slug
    }
    else {
      merged.set(key, { linkId: row.linkId, slug: row.slug, day, dim: row.dim, value: row.value, clicks: row.clicks, source: 'sink' })
    }
  }
  return [...merged.values()]
}

/**
 * Rolls up one America/Chicago day of Analytics Engine access logs into the permanent
 * click_history table for all four dimensions (F21/F22 in
 * docs/reviews/2026-09-28-sink-shortener.rev2.codex-review.md).
 *
 * Atomicity (F21 fix): every AE fetch happens BEFORE any D1 write, so a fetch
 * failure (the realistic failure mode — a network error or an exhausted
 * retry budget) leaves the day's existing rows completely untouched. The D1
 * write itself is stage-then-swap: new rows land under a throwaway
 * `sink-staging:<uuid>` source tag first (the live 'sink' rows for that day
 * are never touched during staging), and only once every staged row has been
 * written does a single atomic `db.batch()` call both delete the old 'sink'
 * rows and promote the staged rows to 'sink' — so if that final batch throws,
 * D1 rolls back both statements together and the previous day's rows survive
 * unchanged. Re-running for the same day is idempotent: stale staging rows
 * from an earlier failed run are cleared before this run stages its own.
 */
export async function rollupHistory(env: Cloudflare.Env, day: string, config: RollupHistoryConfig, options: RollupHistoryOptions = {}): Promise<RollupHistoryResult> {
  const { dataset, cfAccountId, cfApiToken } = config

  // F31 (docs/reviews/2026-09-28-sink-shortener.rev3.codex-review.md): fail
  // closed on missing config instead of silently treating it as "zero
  // clicks today". createAnalyticsFetcher() returns { data: [] } for empty
  // account/token — correct for the dashboard's live "today" read (better to
  // show no data than crash), but disastrous for this write path: an empty
  // result here would stage zero rows and the atomic swap would happily
  // replace a real day of history with nothing. Only the REAL fetcher path
  // needs a live account+token; an injected test fetcher (every test in
  // this file uses one) never calls Cloudflare, so it's exempt.
  if (!dataset)
    throw new Error('rollupHistory: dataset is required (got empty string)')
  if (!options.fetcher && (!cfAccountId || !cfApiToken))
    throw new Error('rollupHistory: cfAccountId and cfApiToken are required for the real Analytics Engine fetcher (got empty value) — refusing to stage a possibly-empty day')

  const fetcher = options.fetcher ?? createAnalyticsFetcher(cfAccountId, cfApiToken)
  const { fromUnix, toUnixExclusive } = unixRangeForCentralDay(day)

  // 1. Fetch every dimension first. Any throw here happens before any D1 write.
  const rawRows: Array<HistoryDimensionRow & { dim: string }> = []
  for (const [dim, column] of HISTORY_DIMS) {
    const dimRows = await fetchHistoryDimension(fetcher, { dataset, fromUnix, toUnixExclusive, dim, column })
    for (const row of dimRows)
      rawRows.push({ ...row, dim })
  }
  const rows = mergeByPrimaryKey(rawRows, day)

  const db = drizzle(env.DB)
  const stageTag = `${STAGING_SOURCE_PREFIX}${crypto.randomUUID()}`

  // 2. Clear any stale staging leftovers from a previously interrupted run for this day, then stage fresh rows.
  await db.delete(clickHistory).where(and(eq(clickHistory.day, day), like(clickHistory.source, `${STAGING_SOURCE_PREFIX}%`)))
  for (let offset = 0; offset < rows.length; offset += STAGE_INSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + STAGE_INSERT_CHUNK).map(row => ({ ...row, source: stageTag }))
    if (chunk.length)
      await db.insert(clickHistory).values(chunk)
  }

  // 3. Atomic swap: delete the old live day and promote the staged rows in ONE batch.
  //    Cloudflare D1 batches execute as a single transaction — either both
  //    statements land, or (on any failure) neither does, so the previous
  //    day's 'sink' rows are never left partially replaced.
  await db.batch([
    db.delete(clickHistory).where(and(eq(clickHistory.day, day), eq(clickHistory.source, 'sink'))),
    db.update(clickHistory).set({ source: 'sink' }).where(and(eq(clickHistory.day, day), eq(clickHistory.source, stageTag))),
  ])

  console.info('[history] rolled up', day, rows.length)
  return { day, rows: rows.length }
}
