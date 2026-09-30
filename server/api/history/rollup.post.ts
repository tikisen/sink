import type { HistoryRollupRunResponse } from '#shared/schemas/history'
import { HistoryRollupBodySchema } from '#shared/schemas/history'
import { nextCentralDay } from '../../utils/history-analytics'
import { rollupHistory } from '../../utils/history-rollup'

defineRouteMeta({
  openAPI: {
    description: 'Backfill or repair the permanent click-history table for a bounded range of America/Chicago days (<= 92 days per call). Runs the same rollup the nightly cron runs.',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: { 'application/json': {} },
    },
  },
})

export default eventHandler(async (event): Promise<HistoryRollupRunResponse> => {
  const { from, to } = await readValidatedBody(event, HistoryRollupBodySchema.parse)
  // useRuntimeConfig(event) (with the event) is the reliable form on Cloudflare —
  // it merges the live Worker env, unlike a bare useRuntimeConfig() call.
  const { cfAccountId, cfApiToken, dataset } = useRuntimeConfig(event)

  const days: HistoryRollupRunResponse['days'] = []
  for (let day = from; day <= to; day = nextCentralDay(day))
    days.push(await rollupHistory(event.context.cloudflare.env, day, { cfAccountId, cfApiToken, dataset }))

  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { from, to, days }
})
