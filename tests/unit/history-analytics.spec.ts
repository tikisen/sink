import { describe, expect, it, vi } from 'vitest'
import {
  buildHistoryDimensionQuery,
  createAnalyticsFetcher,
  fetchHistoryDimension,
  nextUtcDay,
  unixRangeForDay,
  utcDateString,
  utcMonthBucket,
  utcToday,
  utcYesterday,
} from '../../server/utils/history-analytics'

describe('history-analytics date helpers', () => {
  it('formats a UTC date as YYYY-MM-DD', () => {
    expect(utcDateString(new Date('2026-09-28T23:59:59.000Z'))).toBe('2026-09-28')
  })

  it('advances and rewinds UTC calendar days, including across month/year boundaries', () => {
    expect(nextUtcDay('2026-09-28')).toBe('2026-09-29')
    expect(nextUtcDay('2026-09-30')).toBe('2026-10-01')
    expect(nextUtcDay('2026-12-31')).toBe('2027-01-01')
    expect(nextUtcDay('2026-09-28', -1)).toBe('2026-09-27')
    expect(nextUtcDay('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('computes yesterday relative to an explicit today, not the real clock', () => {
    expect(utcYesterday('2026-03-01')).toBe('2026-02-28')
  })

  it('utcToday matches the current UTC date', () => {
    expect(utcToday()).toBe(utcDateString(new Date()))
  })

  it('gives a half-open unix-second range for one UTC day', () => {
    const { fromUnix, toUnixExclusive } = unixRangeForDay('2026-09-28')
    expect(toUnixExclusive - fromUnix).toBe(86_400)
    expect(new Date(fromUnix * 1000).toISOString()).toBe('2026-09-28T00:00:00.000Z')
    expect(new Date(toUnixExclusive * 1000).toISOString()).toBe('2026-09-29T00:00:00.000Z')
  })

  it('buckets a day into its UTC month', () => {
    expect(utcMonthBucket('2026-09-28')).toBe('2026-09')
  })
})

describe('buildHistoryDimensionQuery', () => {
  it('compiles the total dimension with a half-open toDateTime window and no linkId filter', () => {
    const sqlText = buildHistoryDimensionQuery({
      dataset: 'sink',
      fromUnix: 1_790_000_000,
      toUnixExclusive: 1_790_086_400,
      dim: 'total',
      column: null,
    })
    expect(sqlText).toContain('select index1 as link_id, blob1 as slug, \'\' as value, SUM(_sample_interval) as clicks from sink where')
    expect(sqlText).toContain('timestamp >= toDateTime(1790000000)')
    expect(sqlText).toContain('timestamp < toDateTime(1790086400)')
    expect(sqlText).toContain('group by index1, blob1')
    expect(sqlText).not.toContain('index1 =')
    expect(sqlText).not.toContain('?')
  })

  it('compiles a dimension column with an inlined linkId filter and no parameters', () => {
    const sqlText = buildHistoryDimensionQuery({
      dataset: 'sink',
      fromUnix: 1_790_000_000,
      toUnixExclusive: 1_790_086_400,
      dim: 'country',
      column: 'blob6',
      linkId: 'abc123',
    })
    expect(sqlText).toContain('select index1 as link_id, blob1 as slug, blob6 as value, SUM(_sample_interval) as clicks from sink where')
    expect(sqlText).toContain('timestamp >= toDateTime(1790000000)')
    expect(sqlText).toContain('timestamp < toDateTime(1790086400)')
    expect(sqlText).toContain('index1 = \'abc123\'')
    expect(sqlText).toContain('group by index1, blob1, blob6')
    expect(sqlText).not.toContain('?')
  })

  it('rejects an invalid dataset identifier the same way the rest of Sink\'s analytics SQL does', () => {
    expect(() => buildHistoryDimensionQuery({
      dataset: 'sink;drop',
      fromUnix: 0,
      toUnixExclusive: 1,
      dim: 'total',
      column: null,
    })).toThrow('Invalid Analytics dataset')
  })
})

describe('fetchHistoryDimension', () => {
  it('normalizes rows and defaults value to empty string for the total dimension', async () => {
    const fetcher = vi.fn(async () => ({ data: [{ link_id: 'abc', slug: 'x', value: 'US', clicks: '3' }] }))
    const rows = await fetchHistoryDimension(fetcher, { dataset: 'sink', fromUnix: 0, toUnixExclusive: 1, dim: 'total', column: null })
    expect(rows).toEqual([{ linkId: 'abc', slug: 'x', value: '', clicks: 3 }])
  })

  it('rounds fractional sampled clicks and coerces missing fields', async () => {
    const fetcher = vi.fn(async () => ({ data: [{ clicks: '2.6' }] }))
    const rows = await fetchHistoryDimension(fetcher, { dataset: 'sink', fromUnix: 0, toUnixExclusive: 1, dim: 'country', column: 'blob6' })
    expect(rows).toEqual([{ linkId: '', slug: '', value: '', clicks: 3 }])
  })
})

describe('createAnalyticsFetcher', () => {
  it('returns an empty result without calling fetch when account id or token is missing', async () => {
    const fetcher = createAnalyticsFetcher('', '')
    await expect(fetcher('select 1')).resolves.toEqual({ data: [] })
  })
})
