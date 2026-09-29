import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { z } from 'zod'
import { clickHistory } from '../../database/schema'

defineRouteMeta({
  openAPI: {
    description: 'Undated Bitly-era country/referrer totals for one link (day = \'all\', never included in date-filtered /api/history/summary results).',
    security: [{ bearerAuth: [] }],
  },
})

const BitlyAllTimeQuerySchema = z.object({
  linkId: z.string().trim().min(1).max(26),
})

export default eventHandler(async (event) => {
  const { linkId } = await getValidatedQuery(event, BitlyAllTimeQuerySchema.parse)
  const db = drizzle(event.context.cloudflare.env.DB)
  const rows = await db.select({
    dim: clickHistory.dim,
    value: clickHistory.value,
    clicks: clickHistory.clicks,
  }).from(clickHistory).where(and(
    eq(clickHistory.day, 'all'),
    eq(clickHistory.linkId, linkId),
    eq(clickHistory.source, 'bitly'),
  ))

  const byDim = (dim: string) => rows
    .filter(row => row.dim === dim && row.value)
    .sort((a, b) => b.clicks - a.clicks || a.value.localeCompare(b.value))
    .map(({ value, clicks }) => ({ value, clicks }))

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return {
    linkId,
    countries: byDim('country'),
    referers: byDim('referer'),
  }
})
