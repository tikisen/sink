import { looksLikeChunkError, markReloaded, recentlyReloaded } from '@/utils/chunk-error'

/**
 * Global safety net for a stale client hitting a Cloudflare deploy cutover.
 *
 * Nuxt already ships a chunk-reload mechanism (nuxt:chunk-reload), but it
 * only recovers failures that surface through Vue Router's own onError
 * channel -- i.e. a lazy PAGE component failing to load during navigation.
 * It does NOT catch a dynamic import failing later, from something loaded
 * after* a page has already resolved (a nested lazily-loaded component or
 * library used inside an already-mounted page). Reproduced directly:
 * blocking a route's own newly-required chunk on an otherwise-live deploy
 * throws `TypeError: Failed to fetch dynamically imported module: ...` in
 * the browser console, matching the "History nav / link click" reports --
 * this Worker was redeployed several times in quick succession while the
 * dashboard may have stayed open in a tab, so a held bundle could reference
 * a chunk hash the current deployment's asset manifest no longer serves.
 *
 * This deliberately does NOT touch Nuxt's own `vite:preloadError` channel
 * (nuxt:chunk-reload already owns that one, with the correct target path
 * and persisted state) -- it complements it by also listening for an
 * unhandled promise rejection or a plain script error carrying the same
 * "failed to fetch a dynamically imported module" signature, which covers
 * a chunk failing to load *after* navigation already resolved (nothing in
 * Nuxt's default setup catches that case). Recovers with a full reload of
 * the current URL, which always re-fetches a fresh, correctly-hashed
 * bundle from the server. A one-shot guard (sessionStorage) stops a
 * genuinely broken network from reload-looping.
 */
function reloadOnce(reason: string) {
  if (recentlyReloaded(sessionStorage)) {
    console.warn(`[chunk-error-reload] skipping repeat reload (${reason}) -- already reloaded recently`)
    return
  }
  markReloaded(sessionStorage)
  console.warn(`[chunk-error-reload] recovering from ${reason} with a full reload`)
  window.location.reload()
}

export default defineNuxtPlugin(() => {
  window.addEventListener('unhandledrejection', (event) => {
    const message = event.reason instanceof Error ? event.reason.message : String(event.reason ?? '')
    if (looksLikeChunkError(message))
      reloadOnce('unhandledrejection')
  })

  window.addEventListener('error', (event) => {
    if (looksLikeChunkError(event.message))
      reloadOnce('window.onerror')
  })
})
