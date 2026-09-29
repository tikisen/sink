/// <reference path="../../worker-configuration.d.ts" />

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    const env = event.env as Cloudflare.Env
    const config = useRuntimeConfig()

    // Second cron (wrangler.jsonc "15 3 * * *"): nightly click-history rollup
    // for the Sink shortener prototype. Keep this guard first so the daily
    // R2 backup cron below is unaffected.
    if ((event.controller as ScheduledController).cron === '15 3 * * *') {
      await rollupHistory(env, utcYesterday(), {
        dataset: config.dataset,
        cfAccountId: config.cfAccountId,
        cfApiToken: config.cfApiToken,
      })
      return
    }

    if (config.disableAutoBackup) {
      console.info('[backup] Auto backup is disabled by configuration')
      return
    }

    await backupLinksToR2(env)
  })
})
