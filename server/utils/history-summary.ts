import type { HistoryDimensionEntry, HistorySeriesPoint, HistorySummaryResponse } from '../../shared/schemas/history'
import type { HistoryDim } from './history-analytics'
// Relative path (not the #shared alias): this file is imported directly by
// plain unit tests that bypass the Nitro-bundled server, where #shared isn't resolvable.
import { HISTORY_MONTH_BUCKET_THRESHOLD_DAYS } from '../../shared/schemas/history'
import { centralMonthBucket, nextCentralDay } from './history-analytics'

export interface HistoryRow {
  linkId: string
  slug: string
  day: string
  dim: string
  value: string
  clicks: number
}

export interface ComputeHistorySummaryInput {
  from: string
  to: string
  today: string
  /** click_history rows for [from, min(to, yesterday)], day != 'all'. Empty when the range is entirely today or later. */
  historicalRows: HistoryRow[]
  /** Live Analytics Engine rows for `today`, one array per dimension. Only read when includesLiveToday is true. */
  todayByDim: Partial<Record<HistoryDim, HistoryRow[]>>
}

/** Every America/Chicago calendar day in [from, to], inclusive. */
export function enumerateCentralDays(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = from; day <= to; day = nextCentralDay(day))
    days.push(day)
  return days
}

/**
 * Pure computation of the /api/history/summary response (F22 in
 * docs/reviews/2026-09-28-sink-shortener.rev2.codex-review.md): merges
 * permanent click_history rows (days strictly before `today`) with live
 * Analytics Engine rows for `today`, with no double counting because the two
 * inputs never cover the same day. Exported standalone (no D1/event
 * dependency) so its exact semantics — America/Chicago boundaries, tie order, month
 * bucketing, day='all' exclusion — are unit-testable without mocking D1 or
 * the network; server/api/history/summary.get.ts only does the I/O and calls
 * this.
 */
export function computeHistorySummary(input: ComputeHistorySummaryInput): HistorySummaryResponse {
  const { from, to, today, historicalRows, todayByDim } = input
  const includesLiveToday = to >= today && from <= today

  // --- series: one point per Central day, or per Central month above the threshold ---
  const dailyTotals = new Map<string, number>()
  for (const row of historicalRows) {
    if (row.dim === 'total' && row.day !== 'all')
      dailyTotals.set(row.day, (dailyTotals.get(row.day) ?? 0) + row.clicks)
  }
  if (includesLiveToday) {
    const todayTotal = (todayByDim.total ?? []).reduce((sum, row) => sum + row.clicks, 0)
    dailyTotals.set(today, (dailyTotals.get(today) ?? 0) + todayTotal)
  }

  const allDays = enumerateCentralDays(from, to)
  let series: HistorySeriesPoint[]
  if (allDays.length > HISTORY_MONTH_BUCKET_THRESHOLD_DAYS) {
    const monthly = new Map<string, number>()
    for (const day of allDays) {
      const bucket = centralMonthBucket(day)
      monthly.set(bucket, (monthly.get(bucket) ?? 0) + (dailyTotals.get(day) ?? 0))
    }
    series = [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, clicks]) => ({ day, clicks }))
  }
  else {
    series = allDays.map(day => ({ day, clicks: dailyTotals.get(day) ?? 0 }))
  }
  const total = series.reduce((sum, point) => sum + point.clicks, 0)

  // --- topLinks: dim='total' rows grouped by linkId; slug = the most recently seen day's slug ---
  interface LinkAgg { linkId: string, slug: string, clicks: number, lastDay: string }
  const linkAgg = new Map<string, LinkAgg>()
  function addLinkClicks(linkId: string, slug: string, clicks: number, day: string) {
    if (!linkId)
      return
    const existing = linkAgg.get(linkId)
    if (existing) {
      existing.clicks += clicks
      if (day >= existing.lastDay) {
        existing.lastDay = day
        if (slug)
          existing.slug = slug
      }
    }
    else {
      linkAgg.set(linkId, { linkId, slug, clicks, lastDay: day })
    }
  }
  for (const row of historicalRows) {
    if (row.dim === 'total' && row.day !== 'all')
      addLinkClicks(row.linkId, row.slug, row.clicks, row.day)
  }
  if (includesLiveToday) {
    for (const row of todayByDim.total ?? [])
      addLinkClicks(row.linkId, row.slug, row.clicks, today)
  }
  // Tie order: value ascending. topLinks has no `value` field; slug is its analogue.
  const topLinks = [...linkAgg.values()]
    .sort((a, b) => b.clicks - a.clicks || a.slug.localeCompare(b.slug))
    .slice(0, 20)
    .map(({ linkId, slug, clicks }) => ({ linkId, slug, clicks }))

  // --- countries / deviceTypes / referers: grouped by value, tie order value ascending ---
  function aggregateDimension(dim: HistoryDim): HistoryDimensionEntry[] {
    const agg = new Map<string, number>()
    for (const row of historicalRows) {
      if (row.dim === dim && row.day !== 'all' && row.value)
        agg.set(row.value, (agg.get(row.value) ?? 0) + row.clicks)
    }
    for (const row of todayByDim[dim] ?? []) {
      if (row.value)
        agg.set(row.value, (agg.get(row.value) ?? 0) + row.clicks)
    }
    return [...agg.entries()]
      .sort(([valueA, clicksA], [valueB, clicksB]) => clicksB - clicksA || valueA.localeCompare(valueB))
      .slice(0, 10)
      .map(([value, clicks]) => ({ value, clicks }))
  }

  return {
    from,
    to,
    includesLiveToday,
    total,
    series,
    topLinks,
    countries: aggregateDimension('country'),
    deviceTypes: aggregateDimension('deviceType'),
    referers: aggregateDimension('referer'),
  }
}
