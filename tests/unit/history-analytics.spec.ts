import { describe, expect, it, vi } from 'vitest'
import {
  buildHistoryDimensionQuery,
  centralDateString,
  centralMonthBucket,
  centralToday,
  centralYesterday,
  createAnalyticsFetcher,
  fetchHistoryDimension,
  HISTORY_TIME_ZONE,
  nextCentralDay,
  unixRangeForCentralDay,
} from '../../server/utils/history-analytics'

describe('history-analytics date helpers (America/Chicago days, TQ decided 2026-09-30)', () => {
  it('uses America/Chicago as the click-history timezone', () => {
    expect(HISTORY_TIME_ZONE).toBe('America/Chicago')
  })

  it('formats an instant as its America/Chicago calendar day', () => {
    // 2026-09-28T23:59:59Z is 2026-09-28 18:59:59 CDT -- still the 28th.
    expect(centralDateString(new Date('2026-09-28T23:59:59.000Z'))).toBe('2026-09-28')
  })

  it('a late-evening Central click stays on the same Central day even though it is already the next UTC day', () => {
    // The exact bug this migration fixes (same class as the WelcomeMed fix):
    // 23:30 Central on 2026-09-29 is 2026-09-30T04:30:00Z in CDT -- already
    // the 30th in UTC, but still the 29th for the person who clicked.
    const lateEveningCentralClick = new Date('2026-09-29T23:30:00-05:00')
    expect(centralDateString(lateEveningCentralClick)).toBe('2026-09-29')
    expect(lateEveningCentralClick.toISOString().slice(0, 10)).toBe('2026-09-30') // the UTC day it would wrongly land on
  })

  it('advances and rewinds Central calendar days, including across month/year boundaries', () => {
    expect(nextCentralDay('2026-09-28')).toBe('2026-09-29')
    expect(nextCentralDay('2026-09-30')).toBe('2026-10-01')
    expect(nextCentralDay('2026-12-31')).toBe('2027-01-01')
    expect(nextCentralDay('2026-09-28', -1)).toBe('2026-09-27')
    expect(nextCentralDay('2026-01-01', -1)).toBe('2025-12-31')
  })

  it('computes yesterday relative to an explicit today, not the real clock', () => {
    expect(centralYesterday('2026-03-01')).toBe('2026-02-28')
  })

  it('centralToday matches the current instant\'s America/Chicago date', () => {
    expect(centralToday()).toBe(centralDateString(new Date()))
  })

  it('buckets a day into its Central month', () => {
    expect(centralMonthBucket('2026-09-28')).toBe('2026-09')
  })

  describe('unixRangeForCentralDay (DST-aware, per docs/plans/active/2026-09-28-sink-shortener.md)', () => {
    it('gives a 24h window for an ordinary CDT day', () => {
      const { fromUnix, toUnixExclusive } = unixRangeForCentralDay('2026-09-29')
      expect(toUnixExclusive - fromUnix).toBe(86_400)
      expect(new Date(fromUnix * 1000).toISOString()).toBe('2026-09-29T05:00:00.000Z')
      expect(new Date(toUnixExclusive * 1000).toISOString()).toBe('2026-09-30T05:00:00.000Z')
    })

    it('gives a 24h window for an ordinary CST day', () => {
      const { fromUnix, toUnixExclusive } = unixRangeForCentralDay('2026-01-15')
      expect(toUnixExclusive - fromUnix).toBe(86_400)
      expect(new Date(fromUnix * 1000).toISOString()).toBe('2026-01-15T06:00:00.000Z')
      expect(new Date(toUnixExclusive * 1000).toISOString()).toBe('2026-01-16T06:00:00.000Z')
    })

    it('gives a 23h window on the spring-forward transition day (2026-03-08)', () => {
      const { fromUnix, toUnixExclusive } = unixRangeForCentralDay('2026-03-08')
      expect(toUnixExclusive - fromUnix).toBe(23 * 3600)
      expect(new Date(fromUnix * 1000).toISOString()).toBe('2026-03-08T06:00:00.000Z')
      expect(new Date(toUnixExclusive * 1000).toISOString()).toBe('2026-03-09T05:00:00.000Z')
    })

    it('is back to a 24h window the day after spring-forward', () => {
      const { fromUnix, toUnixExclusive } = unixRangeForCentralDay('2026-03-09')
      expect(toUnixExclusive - fromUnix).toBe(86_400)
    })

    it('gives a 25h window on the fall-back transition day (2026-11-01)', () => {
      const { fromUnix, toUnixExclusive } = unixRangeForCentralDay('2026-11-01')
      expect(toUnixExclusive - fromUnix).toBe(25 * 3600)
      expect(new Date(fromUnix * 1000).toISOString()).toBe('2026-11-01T05:00:00.000Z')
      expect(new Date(toUnixExclusive * 1000).toISOString()).toBe('2026-11-02T06:00:00.000Z')
    })

    it('is back to a 24h window the day after fall-back', () => {
      const { fromUnix, toUnixExclusive } = unixRangeForCentralDay('2026-11-02')
      expect(toUnixExclusive - fromUnix).toBe(86_400)
    })

    it('never hardcodes a -5 or -6 offset: every window is computed from the IANA tz database per day', () => {
      // If this were hardcoded to -5 (CDT), the CST day below would be wrong
      // by an hour; if hardcoded to -6 (CST), the CDT day above would be
      // wrong by an hour. Both already-asserted windows above being exactly
      // right, for different offsets, is the proof -- this test just names it.
      const cdt = unixRangeForCentralDay('2026-09-29')
      const cst = unixRangeForCentralDay('2026-01-15')
      expect(new Date(cdt.fromUnix * 1000).getUTCHours()).toBe(5)
      expect(new Date(cst.fromUnix * 1000).getUTCHours()).toBe(6)
    })
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
