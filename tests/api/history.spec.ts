import type { HistorySummaryResponse } from '../../shared/schemas/history'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { clickHistory } from '../../server/database/schema'
import { centralToday } from '../../server/utils/history-analytics'
import { db, fetch, fetchWithAuth, postJson } from '../utils'

const TEST_DAYS = ['2024-02-01', '2024-02-02', '2024-02-03']

async function seed(rows: Array<Partial<typeof clickHistory.$inferInsert> & { linkId: string, day: string, dim: string, clicks: number }>) {
  await db.insert(clickHistory).values(rows.map(row => ({ slug: '', value: '', source: 'sink', ...row })))
}

afterEach(async () => {
  for (const day of [...TEST_DAYS, 'all'])
    await db.delete(clickHistory).where(eq(clickHistory.day, day))
})

async function getSummary(query: Record<string, string>): Promise<HistorySummaryResponse> {
  const params = new URLSearchParams(query)
  const response = await fetchWithAuth(`/api/history/summary?${params}`)
  expect(response.status).toBe(200)
  return response.json()
}

describe('/api/history/summary', { concurrent: false }, () => {
  it('requires auth like every other /api/** route', async () => {
    const response = await fetch(`/api/history/summary?from=2024-02-01&to=2024-02-01`)
    expect(response.status).toBe(401)
  })

  it('rejects from after to and ranges over the max window', async () => {
    expect((await fetchWithAuth('/api/history/summary?from=2024-02-02&to=2024-02-01')).status).toBe(400)
    expect((await fetchWithAuth('/api/history/summary?from=2010-01-01&to=2024-02-01')).status).toBe(400)
  })

  it('sums click_history rows for a historical range and excludes day=\'all\' Bitly totals', async () => {
    await seed([
      { linkId: 'link-1', slug: 'a', day: '2024-02-01', dim: 'total', clicks: 3 },
      { linkId: 'link-1', slug: 'a', day: '2024-02-02', dim: 'total', clicks: 5, source: 'bitly' },
      { linkId: '', slug: '', day: 'all', dim: 'country', value: 'US', clicks: 999, source: 'bitly' },
    ])

    const data = await getSummary({ from: '2024-02-01', to: '2024-02-03' })
    expect(data.total).toBe(8)
    expect(data.series).toEqual([
      { day: '2024-02-01', clicks: 3 },
      { day: '2024-02-02', clicks: 5 },
      { day: '2024-02-03', clicks: 0 },
    ])
    // day='all' must never leak into a date-filtered result, even though 'US' would otherwise be the only country.
    expect(data.countries).toEqual([])
  })

  it('scopes every field to linkId when provided', async () => {
    await seed([
      { linkId: 'link-1', slug: 'a', day: '2024-02-01', dim: 'total', clicks: 3 },
      { linkId: 'link-2', slug: 'b', day: '2024-02-01', dim: 'total', clicks: 4 },
    ])

    const scoped = await getSummary({ from: '2024-02-01', to: '2024-02-01', linkId: 'link-1' })
    expect(scoped.total).toBe(3)
    expect(scoped.topLinks).toEqual([{ linkId: 'link-1', slug: 'a', clicks: 3 }])

    const unscoped = await getSummary({ from: '2024-02-01', to: '2024-02-01' })
    expect(unscoped.total).toBe(7)
  })

  it('reports includesLiveToday only when the requested range reaches the current America/Chicago day', async () => {
    const past = await getSummary({ from: '2024-02-01', to: '2024-02-02' })
    expect(past.includesLiveToday).toBe(false)

    const today = centralToday()
    const current = await getSummary({ from: today, to: today })
    expect(current.includesLiveToday).toBe(true)
    // No Analytics Engine token is configured in the test env, so live "today"
    // data comes back empty rather than erroring — the route still succeeds.
    expect(current.total).toBe(0)
  })
})

describe('/api/history/rollup', { concurrent: false }, () => {
  it('fails closed (500) when no Analytics Engine token is configured, rather than silently writing empty days (F31)', async () => {
    // The test env has no NUXT_CF_ACCOUNT_ID/NUXT_CF_API_TOKEN configured —
    // this proves the HTTP backfill route surfaces rollupHistory's fail-closed
    // guard (server/utils/history-rollup.ts) instead of quietly succeeding
    // with zero rows, which is what used to happen before the F31 fix.
    await seed([{ linkId: 'link-1', slug: 'a', day: '2024-02-01', dim: 'total', clicks: 3 }])
    const response = await postJson('/api/history/rollup', { from: '2024-02-01', to: '2024-02-01' })
    expect(response.status).toBe(500)

    // And the existing day must be provably untouched by the failed attempt.
    const rows = await db.select().from(clickHistory).where(eq(clickHistory.day, '2024-02-01'))
    expect(rows).toEqual([expect.objectContaining({ linkId: 'link-1', clicks: 3 })])
  })

  it('rejects a backfill range over 92 days', async () => {
    const response = await postJson('/api/history/rollup', { from: '2024-01-01', to: '2024-12-31' })
    expect(response.status).toBe(400)
  })
})

describe('/api/history/bitly-all-time', { concurrent: false }, () => {
  it('returns only day=\'all\' bitly-sourced rows for the given link', async () => {
    await seed([
      { linkId: 'link-1', slug: '', day: 'all', dim: 'country', value: 'US', clicks: 20, source: 'bitly' },
      { linkId: 'link-1', slug: '', day: 'all', dim: 'referer', value: 'twitter.com', clicks: 5, source: 'bitly' },
      { linkId: 'link-1', slug: 'a', day: '2024-02-01', dim: 'total', clicks: 3 }, // dated — must not appear
      { linkId: 'link-2', slug: '', day: 'all', dim: 'country', value: 'CA', clicks: 1, source: 'bitly' }, // different link
    ])

    const response = await fetchWithAuth('/api/history/bitly-all-time?linkId=link-1')
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.countries).toEqual([{ value: 'US', clicks: 20 }])
    expect(data.referers).toEqual([{ value: 'twitter.com', clicks: 5 }])
  })
})
