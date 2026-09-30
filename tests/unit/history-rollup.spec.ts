import type { AnalyticsFetcher } from '../../server/utils/history-analytics'
import type { RollupHistoryConfig } from '../../server/utils/history-rollup'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { afterEach, describe, expect, it } from 'vitest'
import { clickHistory } from '../../server/database/schema'
import { rollupHistory } from '../../server/utils/history-rollup'

const db = drizzle(env.DB)
const DIM_ORDER = ['total', 'country', 'deviceType', 'referer'] as const
const TEST_CONFIG: RollupHistoryConfig = { dataset: 'sink', cfAccountId: '', cfApiToken: '' }

/** A fetcher that returns `totalRows` for the 'total' dimension call and nothing for the other three. */
function totalOnlyFetcher(totalRows: Array<{ link_id: string, slug: string, clicks: string }>): AnalyticsFetcher {
  let callIndex = 0
  return async () => {
    const dim = DIM_ORDER[callIndex % DIM_ORDER.length]
    callIndex++
    return { data: dim === 'total' ? totalRows : [] }
  }
}

async function rowsForDay(day: string) {
  return db.select().from(clickHistory).where(eq(clickHistory.day, day))
}

afterEach(async () => {
  for (const day of ['2024-01-10', '2024-01-11', '2024-01-12', '2024-01-13'])
    await db.delete(clickHistory).where(eq(clickHistory.day, day))
})

describe('rollupHistory — atomicity (F21)', { concurrent: false }, () => {
  it('leaves the existing day untouched when the Analytics Engine fetch fails partway through', async () => {
    const day = '2024-01-10'
    await db.insert(clickHistory).values({ linkId: 'link-1', slug: 'existing', day, dim: 'total', value: '', clicks: 42, source: 'sink' })

    let calls = 0
    const failingFetcher: AnalyticsFetcher = async () => {
      calls++
      if (calls === 3) // fails on the 3rd of 4 dimension calls — after 'total' and 'country' already fetched, before any D1 write
        throw new Error('simulated AE outage')
      return { data: [] }
    }

    await expect(rollupHistory(env, day, TEST_CONFIG, { fetcher: failingFetcher })).rejects.toThrow('simulated AE outage')
    expect(calls).toBe(3)

    const rows = await rowsForDay(day)
    expect(rows).toEqual([expect.objectContaining({ linkId: 'link-1', slug: 'existing', day, dim: 'total', clicks: 42, source: 'sink' })])
  })

  it('is idempotent across repeated runs and leaves no staging rows behind', async () => {
    const day = '2024-01-11'
    const fetcher = totalOnlyFetcher([{ link_id: 'link-1', slug: 'my-slug', clicks: '5' }])

    const first = await rollupHistory(env, day, TEST_CONFIG, { fetcher: totalOnlyFetcher([{ link_id: 'link-1', slug: 'my-slug', clicks: '5' }]) })
    expect(first).toEqual({ day, rows: 1 })
    const second = await rollupHistory(env, day, TEST_CONFIG, { fetcher })
    expect(second).toEqual({ day, rows: 1 })

    const rows = await rowsForDay(day)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ linkId: 'link-1', slug: 'my-slug', clicks: 5, source: 'sink' })
    expect(rows.some(row => row.source.startsWith('sink-staging:'))).toBe(false)
  })

  it('replaces a previous rollup for the same day with the new totals, not accumulating them', async () => {
    const day = '2024-01-13'
    await rollupHistory(env, day, TEST_CONFIG, { fetcher: totalOnlyFetcher([{ link_id: 'link-1', slug: 'slug-v1', clicks: '10' }]) })
    await rollupHistory(env, day, TEST_CONFIG, { fetcher: totalOnlyFetcher([{ link_id: 'link-1', slug: 'slug-v2', clicks: '3' }]) })

    const rows = await rowsForDay(day)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ slug: 'slug-v2', clicks: 3 })
  })
})

describe('rollupHistory — fails closed on missing config (F31)', { concurrent: false }, () => {
  it('throws before touching D1 when cfAccountId/cfApiToken are empty and no fetcher is injected', async () => {
    const day = '2024-01-10'
    await db.insert(clickHistory).values({ linkId: 'link-1', slug: 'existing', day, dim: 'total', value: '', clicks: 42, source: 'sink' })

    // No `fetcher` option — this exercises the REAL createAnalyticsFetcher path,
    // which is exactly the scheduled-hook code path this finding is about.
    await expect(rollupHistory(env, day, { dataset: 'sink', cfAccountId: '', cfApiToken: '' }))
      .rejects
      .toThrow('cfAccountId and cfApiToken are required')

    const rows = await rowsForDay(day)
    expect(rows).toEqual([expect.objectContaining({ linkId: 'link-1', clicks: 42, source: 'sink' })])
  })

  it('throws when dataset is empty, even with a fetcher injected', async () => {
    await expect(rollupHistory(env, '2024-01-11', { dataset: '', cfAccountId: 'x', cfApiToken: 'y' }, { fetcher: totalOnlyFetcher([]) }))
      .rejects
      .toThrow('dataset is required')
  })

  it('does NOT throw when a fetcher is injected, even with empty account/token (the test-only path)', async () => {
    await expect(rollupHistory(env, '2024-01-13', TEST_CONFIG, { fetcher: totalOnlyFetcher([]) })).resolves.toEqual({ day: '2024-01-13', rows: 0 })
  })
})

describe('rollupHistory — stays under D1\'s bound-parameter limit per statement', { concurrent: false }, () => {
  it('stages more than 50 rows (the old, too-large chunk size) without a D1 "too many parameters" failure', async () => {
    // Found running the real Central-day re-bucket (docs/plans/active/
    // 2026-09-28-sink-shortener.md): a day with 50 links in one dimension
    // produced a 50-row insert (350 bound params at 7 columns/row) and D1
    // rejected the whole statement with a 500. This seeds enough distinct
    // link ids to span multiple insert chunks and proves the write survives.
    const day = '2024-01-14'
    const totalRows = Array.from({ length: 63 }, (_, i) => ({ link_id: `link-${i}`, slug: `slug-${i}`, clicks: '1' }))
    const result = await rollupHistory(env, day, TEST_CONFIG, { fetcher: totalOnlyFetcher(totalRows) })
    expect(result.rows).toBe(63)

    const rows = await rowsForDay(day)
    expect(rows).toHaveLength(63)
    await db.delete(clickHistory).where(eq(clickHistory.day, day))
  })
})

describe('rollupHistory — merges duplicate primary keys before writing', { concurrent: false }, () => {
  it('sums clicks into one row when AE returns two rows for the same link (a mid-day slug rename)', async () => {
    const day = '2024-01-12'
    const fetcher = totalOnlyFetcher([
      { link_id: 'link-1', slug: 'old-slug', clicks: '3' },
      { link_id: 'link-1', slug: 'new-slug', clicks: '4' },
    ] as any)

    const result = await rollupHistory(env, day, TEST_CONFIG, { fetcher })
    expect(result.rows).toBe(1) // merged to one row, not two — would otherwise violate the (linkId, day, dim, value, source) primary key

    const rows = await rowsForDay(day)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ linkId: 'link-1', slug: 'new-slug', clicks: 7 })
  })
})
