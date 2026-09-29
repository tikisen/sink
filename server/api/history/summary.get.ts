import type { HistorySummaryResponse } from '#shared/schemas/history'
import type { HistoryDim } from '../../utils/history-analytics'
import type { HistoryRow } from '../../utils/history-summary'
import { and, eq, gte, lte, ne } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { HistorySummaryQuerySchema } from '#shared/schemas/history'
import { clickHistory } from '../../database/schema'
import { createAnalyticsFetcher, fetchHistoryDimension, HISTORY_DIMS, unixRangeForDay, utcToday, utcYesterday } from '../../utils/history-analytics'
import { computeHistorySummary } from '../../utils/history-summary'

defineRouteMeta({
  openAPI: {
    description: 'Permanent click-history summary: merges the click_history table (days before today) with live Analytics Engine (today), UTC [from, to] inclusive.',
    security: [{ bearerAuth: [] }],
  },
})

export default eventHandler(async (event): Promise<HistorySummaryResponse> => {
  const { from, to, linkId } = await getValidatedQuery(event, HistorySummaryQuerySchema.parse)
  const today = utcToday()

  // click_history only ever holds completed days (the rollup writes yesterday
  // at 03:15 UTC); today's count comes live from Analytics Engine so a click
  // that just happened is never missing and never double-counted against
  // tonight's rollup for the same day.
  const includesLiveToday = to >= today && from <= today
  const historicalTo = to < today ? to : utcYesterday(today)
  const hasHistoricalPortion = from <= historicalTo

  const db = drizzle(event.context.cloudflare.env.DB)
  let historicalRows: HistoryRow[] = []
  if (hasHistoricalPortion) {
    const conditions = [ne(clickHistory.day, 'all'), gte(clickHistory.day, from), lte(clickHistory.day, historicalTo)]
    if (linkId)
      conditions.push(eq(clickHistory.linkId, linkId))
    historicalRows = await db.select({
      linkId: clickHistory.linkId,
      slug: clickHistory.slug,
      day: clickHistory.day,
      dim: clickHistory.dim,
      value: clickHistory.value,
      clicks: clickHistory.clicks,
    }).from(clickHistory).where(and(...conditions))
  }

  const todayByDim: Partial<Record<HistoryDim, HistoryRow[]>> = {}
  if (includesLiveToday) {
    const { cfAccountId, cfApiToken, dataset } = useRuntimeConfig(event)
    const fetcher = createAnalyticsFetcher(cfAccountId, cfApiToken)
    const { fromUnix, toUnixExclusive } = unixRangeForDay(today)
    for (const [dim, column] of HISTORY_DIMS) {
      const rows = await fetchHistoryDimension(fetcher, { dataset, fromUnix, toUnixExclusive, dim, column, linkId })
      todayByDim[dim] = rows.map(row => ({ ...row, day: today, dim }))
    }
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return computeHistorySummary({ from, to, today, historicalRows, todayByDim })
})
