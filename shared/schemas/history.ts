import { z } from 'zod'

/**
 * Exact contract for the permanent click-history feature (Sink + imported Bitly
 * data). See docs/plans/active/2026-09-28-sink-shortener.md Phase 3 for the
 * design this implements, and its Rev 2 review (F21/F22) for why the rollup is
 * stage-then-swap and why this schema pins down semantics a prose spec left
 * ambiguous.
 */

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_SUMMARY_RANGE_DAYS = 3660
/** Above this many days, `series` buckets by America/Chicago month ('YYYY-MM') instead of day. */
export const HISTORY_MONTH_BUCKET_THRESHOLD_DAYS = 92

export const HistoryDaySchema = z.string().regex(DAY_PATTERN, 'must be YYYY-MM-DD')

function daysBetweenInclusive(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  return Math.round((toMs - fromMs) / 86_400_000) + 1
}

export const HistorySummaryQuerySchema = z.object({
  from: HistoryDaySchema.describe('Start of the window, inclusive, America/Chicago calendar day (YYYY-MM-DD).'),
  to: HistoryDaySchema.describe('End of the window, inclusive, America/Chicago calendar day (YYYY-MM-DD).'),
  linkId: z.string().trim().min(1).max(26).optional().describe('Restrict to one link (links.id, stable across slug renames).'),
}).refine(({ from, to }) => from <= to, {
  message: 'from must be less than or equal to to',
  path: ['from'],
}).refine(({ from, to }) => daysBetweenInclusive(from, to) <= MAX_SUMMARY_RANGE_DAYS, {
  message: `range must not exceed ${MAX_SUMMARY_RANGE_DAYS} days`,
  path: ['to'],
})

export type HistorySummaryQuery = z.infer<typeof HistorySummaryQuerySchema>

export const HistoryRollupBodySchema = z.object({
  from: HistoryDaySchema,
  to: HistoryDaySchema,
}).refine(({ from, to }) => from <= to, {
  message: 'from must be less than or equal to to',
  path: ['from'],
}).refine(({ from, to }) => daysBetweenInclusive(from, to) <= HISTORY_MONTH_BUCKET_THRESHOLD_DAYS, {
  message: `backfill range must not exceed ${HISTORY_MONTH_BUCKET_THRESHOLD_DAYS} days per request`,
  path: ['to'],
})

export type HistoryRollupBody = z.infer<typeof HistoryRollupBodySchema>

export interface HistorySeriesPoint {
  /** 'YYYY-MM-DD', or 'YYYY-MM' when the range exceeds HISTORY_MONTH_BUCKET_THRESHOLD_DAYS. */
  day: string
  clicks: number
}

export interface HistoryTopLink {
  linkId: string
  slug: string
  clicks: number
}

export interface HistoryDimensionEntry {
  value: string
  clicks: number
}

export interface HistorySummaryResponse {
  from: string
  to: string
  /** True when `to` includes the current America/Chicago day, whose count came from live Analytics Engine, not the permanent table. */
  includesLiveToday: boolean
  total: number
  series: HistorySeriesPoint[]
  topLinks: HistoryTopLink[]
  countries: HistoryDimensionEntry[]
  deviceTypes: HistoryDimensionEntry[]
  referers: HistoryDimensionEntry[]
}

export interface HistoryRollupDayResult {
  day: string
  rows: number
}

export interface HistoryRollupRunResponse {
  from: string
  to: string
  days: HistoryRollupDayResult[]
}
