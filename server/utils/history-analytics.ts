import { sql } from 'kysely'
import { compileAnalyticsQuery, createAnalyticsQuery } from './analytics-sql'

/**
 * The four dimensions the nightly rollup and the live "today" query both read.
 * Column names are Analytics Engine blob positions written by
 * server/utils/access-log.ts (blob1 slug, blob5 referer, blob6 country,
 * blob15 deviceType, index1 link id).
 */
export const HISTORY_DIMS = [
  ['total', null],
  ['country', 'blob6'],
  ['deviceType', 'blob15'],
  ['referer', 'blob5'],
] as const

export type HistoryDim = typeof HISTORY_DIMS[number][0]

export interface HistoryDimensionRow {
  linkId: string
  slug: string
  value: string
  clicks: number
}

export type AnalyticsFetcher = (sqlText: string) => Promise<{ data: Array<Record<string, unknown>> }>

/** Real fetcher: same endpoint/shape as server/utils/cloudflare.ts's useWAE, but callable outside an H3Event (the scheduled plugin has none). */
export function createAnalyticsFetcher(cfAccountId: string, cfApiToken: string): AnalyticsFetcher {
  return async (sqlText: string) => {
    if (!cfAccountId || !cfApiToken)
      return { data: [] }

    return await $fetch<{ data: Array<Record<string, unknown>> }>(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/analytics_engine/sql`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfApiToken}` },
        body: sqlText,
        retry: 3,
        retryDelay: 2000,
      },
    )
  }
}

/**
 * Builds the compiled (parameter-free) Analytics Engine SQL for one dimension
 * over a half-open UTC unix-second window [fromUnix, toUnixExclusive), using
 * the same createAnalyticsQuery/compileAnalyticsQuery path and
 * toDateTime(<unix>) convention as server/utils/query-filter.ts, so this
 * follows Sink's own compiled-query contract instead of hand-written SQL.
 */
export function buildHistoryDimensionQuery(params: {
  dataset: string
  fromUnix: number
  toUnixExclusive: number
  dim: HistoryDim
  column: string | null
  linkId?: string
}): string {
  const { dataset, fromUnix, toUnixExclusive, dim, column, linkId } = params
  const timeFilter = sql<boolean>`${sql.ref('timestamp')} >= toDateTime(${sql.lit(fromUnix)}) and ${sql.ref('timestamp')} < toDateTime(${sql.lit(toUnixExclusive)})`
  const filter = linkId
    ? sql<boolean>`${timeFilter} and ${sql.ref('index1')} = ${sql.lit(linkId)}`
    : timeFilter

  const selects = [
    sql.ref('index1').as('link_id'),
    sql.ref('blob1').as('slug'),
    (column ? sql.ref(column) : sql<string>`''`).as('value'),
    sql<number>`SUM(_sample_interval)`.as('clicks'),
  ]
  const groupBy = column ? ['index1', 'blob1', column] : ['index1', 'blob1']

  const query = createAnalyticsQuery(dataset)
    .select(selects)
    .where(filter)
    .groupBy(groupBy)

  void dim // dim is the caller's label for the result set; the query itself only needs `column`.
  return compileAnalyticsQuery(query)
}

/** Reads one dimension via the injected fetcher and normalizes rows. */
export async function fetchHistoryDimension(
  fetcher: AnalyticsFetcher,
  params: Parameters<typeof buildHistoryDimensionQuery>[0],
): Promise<HistoryDimensionRow[]> {
  const sqlText = buildHistoryDimensionQuery(params)
  const result = await fetcher(sqlText)
  return result.data.map(row => ({
    linkId: String(row.link_id ?? ''),
    slug: String(row.slug ?? ''),
    value: params.column ? String(row.value ?? '') : '',
    clicks: Math.round(Number(row.clicks) || 0),
  }))
}

export function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function utcToday(): string {
  return utcDateString(new Date())
}

export function utcYesterday(from: string = utcToday()): string {
  return nextUtcDay(from, -1)
}

/** Adds `offsetDays` (default 1) UTC calendar days to a 'YYYY-MM-DD' string. */
export function nextUtcDay(day: string, offsetDays = 1): string {
  const [year, month, date] = day.split('-').map(Number)
  const next = new Date(Date.UTC(year!, month! - 1, date! + offsetDays))
  return utcDateString(next)
}

/** [fromUnix, toUnixExclusive) for one UTC calendar day. */
export function unixRangeForDay(day: string): { fromUnix: number, toUnixExclusive: number } {
  const [year, month, date] = day.split('-').map(Number)
  const fromUnix = Date.UTC(year!, month! - 1, date!) / 1000
  const toUnixExclusive = Date.UTC(year!, month! - 1, date! + 1) / 1000
  return { fromUnix, toUnixExclusive }
}

export function utcMonthBucket(day: string): string {
  return day.slice(0, 7)
}
