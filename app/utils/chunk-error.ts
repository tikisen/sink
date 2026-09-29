/**
 * Pure decision logic for app/plugins/chunk-error-reload.client.ts -- kept
 * here, separate from the DOM/window wiring, so it's directly unit
 * testable. See that file for the full rationale.
 */
export const CHUNK_ERROR_PATTERN = /fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css/i

export function looksLikeChunkError(message: string | undefined | null): boolean {
  return !!message && CHUNK_ERROR_PATTERN.test(message)
}

export interface ReloadGuardStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const RELOAD_GUARD_KEY = 'sink:chunk-error-reload'
export const RELOAD_GUARD_WINDOW_MS = 10_000

export function recentlyReloaded(storage: ReloadGuardStorage, now = Date.now()): boolean {
  try {
    const raw = storage.getItem(RELOAD_GUARD_KEY)
    if (!raw)
      return false
    const at = Number(raw)
    return Number.isFinite(at) && now - at < RELOAD_GUARD_WINDOW_MS
  }
  catch {
    // Storage can throw in locked-down/private contexts -- treat as "no
    // guard available" rather than blocking recovery.
    return false
  }
}

export function markReloaded(storage: ReloadGuardStorage, now = Date.now()): void {
  try {
    storage.setItem(RELOAD_GUARD_KEY, String(now))
  }
  catch {}
}
