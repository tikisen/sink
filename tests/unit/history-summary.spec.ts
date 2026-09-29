import type { HistoryRow } from '../../server/utils/history-summary'
import { describe, expect, it } from 'vitest'
import { computeHistorySummary, enumerateUtcDays } from '../../server/utils/history-summary'

function row(overrides: Partial<HistoryRow>): HistoryRow {
  return { linkId: 'link-1', slug: 'slug-1', day: '2026-09-27', dim: 'total', value: '', clicks: 1, ...overrides }
}

describe('enumerateUtcDays', () => {
  it('is inclusive of both endpoints', () => {
    expect(enumerateUtcDays('2026-09-27', '2026-09-29')).toEqual(['2026-09-27', '2026-09-28', '2026-09-29'])
  })

  it('returns exactly one day when from equals to', () => {
    expect(enumerateUtcDays('2026-09-27', '2026-09-27')).toEqual(['2026-09-27'])
  })
})

describe('computeHistorySummary — midnight boundary and D1/AE split', () => {
  it('does not include yesterday in the live-AE portion and does not include today in the D1 portion', () => {
    const result = computeHistorySummary({
      from: '2026-09-27',
      to: '2026-09-28',
      today: '2026-09-28',
      historicalRows: [row({ day: '2026-09-27', clicks: 5 })],
      todayByDim: { total: [row({ day: '2026-09-28', clicks: 7 })] },
    })

    expect(result.includesLiveToday).toBe(true)
    expect(result.series).toEqual([
      { day: '2026-09-27', clicks: 5 },
      { day: '2026-09-28', clicks: 7 },
    ])
    expect(result.total).toBe(12)
  })

  it('a range entirely before today never touches todayByDim, even if it were (wrongly) populated', () => {
    const result = computeHistorySummary({
      from: '2026-09-01',
      to: '2026-09-27',
      today: '2026-09-28',
      historicalRows: [row({ day: '2026-09-27', clicks: 5 })],
      // Simulates a caller bug: today data present even though it should never be read for this range.
      todayByDim: { total: [row({ day: '2026-09-28', clicks: 999 })] },
    })

    expect(result.includesLiveToday).toBe(false)
    expect(result.total).toBe(5)
    expect(result.series.at(-1)).toEqual({ day: '2026-09-27', clicks: 5 })
  })

  it('a range starting after today has no historical portion and total comes entirely from today', () => {
    const result = computeHistorySummary({
      from: '2026-09-28',
      to: '2026-09-28',
      today: '2026-09-28',
      historicalRows: [],
      todayByDim: { total: [row({ day: '2026-09-28', clicks: 4 })] },
    })
    expect(result.total).toBe(4)
    expect(result.series).toEqual([{ day: '2026-09-28', clicks: 4 }])
  })
})

describe('computeHistorySummary — day = \'all\' exclusion', () => {
  it('never includes Bitly undated dimension totals (day = \'all\') in date-filtered results', () => {
    const result = computeHistorySummary({
      from: '2026-01-01',
      to: '2026-12-31',
      today: '2027-01-01',
      historicalRows: [
        row({ day: '2026-05-01', dim: 'country', value: 'US', clicks: 10 }),
        // Same link/dimension/value, but undated — must be excluded even though it falls inside the numeric string range.
        row({ day: 'all', dim: 'country', value: 'US', clicks: 999 }),
        row({ day: 'all', dim: 'total', clicks: 999 }),
      ],
      todayByDim: {},
    })

    expect(result.countries).toEqual([{ value: 'US', clicks: 10 }])
    expect(result.total).toBe(0) // the only 'total' row is day='all' and must be excluded
  })
})

describe('computeHistorySummary — top-N tie order', () => {
  it('breaks equal-click ties by value ascending for dimension lists', () => {
    const result = computeHistorySummary({
      from: '2026-09-27',
      to: '2026-09-27',
      today: '2026-09-28',
      historicalRows: [
        row({ dim: 'country', value: 'ZZ', clicks: 3 }),
        row({ dim: 'country', value: 'AA', clicks: 3 }),
        row({ dim: 'country', value: 'MM', clicks: 5 }),
      ],
      todayByDim: {},
    })
    expect(result.countries).toEqual([
      { value: 'MM', clicks: 5 },
      { value: 'AA', clicks: 3 },
      { value: 'ZZ', clicks: 3 },
    ])
  })

  it('breaks equal-click ties by slug ascending for topLinks', () => {
    const result = computeHistorySummary({
      from: '2026-09-27',
      to: '2026-09-27',
      today: '2026-09-28',
      historicalRows: [
        row({ linkId: 'link-z', slug: 'zeta', clicks: 2 }),
        row({ linkId: 'link-a', slug: 'alpha', clicks: 2 }),
      ],
      todayByDim: {},
    })
    expect(result.topLinks.map(link => link.slug)).toEqual(['alpha', 'zeta'])
  })

  it('sums clicks for the same link across multiple historical days and keeps the most recent slug', () => {
    const result = computeHistorySummary({
      from: '2026-09-01',
      to: '2026-09-27',
      today: '2026-09-28',
      historicalRows: [
        row({ linkId: 'link-1', slug: 'old-slug', day: '2026-09-01', clicks: 4 }),
        row({ linkId: 'link-1', slug: 'new-slug', day: '2026-09-20', clicks: 6 }),
      ],
      todayByDim: {},
    })
    expect(result.topLinks).toEqual([{ linkId: 'link-1', slug: 'new-slug', clicks: 10 }])
  })
})

describe('computeHistorySummary — month bucketing above the 92-day threshold', () => {
  it('buckets by day for a 92-day range and by month for a 93-day range', () => {
    const dayResult = computeHistorySummary({
      from: '2026-01-01',
      to: '2026-04-02', // 92 days inclusive
      today: '2026-12-31',
      historicalRows: [row({ day: '2026-02-15', clicks: 7 })],
      todayByDim: {},
    })
    expect(dayResult.series.every(point => /^\d{4}-\d{2}-\d{2}$/.test(point.day))).toBe(true)
    expect(dayResult.series.find(point => point.day === '2026-02-15')?.clicks).toBe(7)

    const monthResult = computeHistorySummary({
      from: '2026-01-01',
      to: '2026-04-03', // 93 days inclusive
      today: '2026-12-31',
      historicalRows: [
        row({ day: '2026-02-01', clicks: 3 }),
        row({ day: '2026-02-28', clicks: 4 }),
        row({ day: '2026-04-03', clicks: 1 }),
      ],
      todayByDim: {},
    })
    expect(monthResult.series.every(point => /^\d{4}-\d{2}$/.test(point.day))).toBe(true)
    expect(monthResult.series).toEqual(expect.arrayContaining([
      { day: '2026-02', clicks: 7 },
      { day: '2026-04', clicks: 1 },
    ]))
    expect(monthResult.total).toBe(8)
  })
})

describe('computeHistorySummary — linkId scoping is the caller\'s responsibility', () => {
  it('only aggregates the rows it is given (the route pre-filters by linkId in D1/AE)', () => {
    const result = computeHistorySummary({
      from: '2026-09-27',
      to: '2026-09-27',
      today: '2026-09-28',
      historicalRows: [row({ linkId: 'only-this-link', clicks: 9 })],
      todayByDim: {},
    })
    expect(result.topLinks).toEqual([{ linkId: 'only-this-link', slug: 'slug-1', clicks: 9 }])
  })
})
