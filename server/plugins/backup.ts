/// <reference path="../../worker-configuration.d.ts" />

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    const env = event.env as Cloudflare.Env

    // Second cron (wrangler.jsonc "15 3 * * *"): nightly click-history rollup
    // for the Sink shortener prototype. Keep this guard first so the daily
    // R2 backup cron below is unaffected.
    if ((event.controller as ScheduledController).cron === '15 3 * * *') {
      await runScheduledRollup(env)
      return
    }

    const config = useRuntimeConfig()

    if (config.disableAutoBackup) {
      console.info('[backup] Auto backup is disabled by configuration')
      return
    }

    await backupLinksToR2(env)
  })
})

/**
 * F31 (docs/reviews/2026-09-28-sink-shortener.rev3.codex-review.md): a
 * scheduled event has no H3Event, so `useRuntimeConfig()` here is a BARE
 * call — and a bare call only ever reflects Nitro's build-time-resolved
 * config, never the live Worker secrets/vars (Cloudflare Workers have no
 * real `process.env`; the per-request merge that makes `useRuntimeConfig
 * (event)` see `NUXT_CF_ACCOUNT_ID`/`NUXT_CF_API_TOKEN` needs that event).
 * Confirmed while investigating this finding: NUXT_CF_ACCOUNT_ID,
 * NUXT_CF_API_TOKEN, and NUXT_DATASET are all real properties on
 * Cloudflare.Env itself (see worker-configuration.d.ts) — the scheduled
 * handler's own `event.env` already carries every Worker var and secret by
 * its exact NUXT_* name, the same way it already carries DB/KV/R2/ANALYTICS.
 * Reading them from there instead of runtimeConfig is both correct and
 * simpler, and it fails closed: if a secret is ever unset, this function
 * (not rollupHistory) is the first line of defense, but rollupHistory
 * itself also refuses to run without a live account+token (belt and
 * suspenders — see its own guard).
 */
async function runScheduledRollup(env: Cloudflare.Env): Promise<void> {
  const dataset = env.NUXT_DATASET
  const cfAccountId = env.NUXT_CF_ACCOUNT_ID
  const cfApiToken = env.NUXT_CF_API_TOKEN

  if (!dataset || !cfAccountId || !cfApiToken) {
    console.error('[history] scheduled rollup skipped: missing Worker config', {
      hasDataset: !!dataset,
      hasAccountId: !!cfAccountId,
      hasApiToken: !!cfApiToken,
    })
    return
  }

  try {
    await rollupHistory(env, utcYesterday(), { dataset, cfAccountId, cfApiToken })
  }
  catch (error) {
    // rollupHistory's own fetch-before-write ordering (F21) already
    // guarantees the previous day's rows survive any Analytics Engine
    // failure — this catch only stops that failure from crashing the
    // scheduled handler itself (which would also skip tonight's backup,
    // since Cloudflare only fires one hook invocation per matching cron).
    console.error('[history] scheduled rollup failed', error instanceof Error ? error.message : String(error))
  }
}
