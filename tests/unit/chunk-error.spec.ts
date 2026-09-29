import type { ReloadGuardStorage } from '../../app/utils/chunk-error'
import { describe, expect, it } from 'vitest'
import { looksLikeChunkError, markReloaded, recentlyReloaded, RELOAD_GUARD_KEY, RELOAD_GUARD_WINDOW_MS } from '../../app/utils/chunk-error'

function fakeStorage(initial: Record<string, string> = {}): ReloadGuardStorage {
  const store = new Map(Object.entries(initial))
  return {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
  }
}

describe('looksLikeChunkError', () => {
  it('matches the real error this bug produces (reproduced live)', () => {
    expect(looksLikeChunkError('TypeError: Failed to fetch dynamically imported module: https://sink.tq-78a.workers.dev/_nuxt/C4aSUO2D.js')).toBe(true)
  })

  it('matches Firefox/Safari phrasing variants', () => {
    expect(looksLikeChunkError('error loading dynamically imported module: https://example.com/chunk.js')).toBe(true)
    expect(looksLikeChunkError('Importing a module script failed')).toBe(true)
  })

  it('matches the CSS-preload variant Vite also emits for the same class of staleness', () => {
    expect(looksLikeChunkError('Unable to preload CSS for /_nuxt/entry.css')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(looksLikeChunkError('FAILED TO FETCH DYNAMICALLY IMPORTED MODULE')).toBe(true)
  })

  it('does not match an unrelated error', () => {
    expect(looksLikeChunkError('TypeError: Cannot read properties of undefined (reading \'slug\')')).toBe(false)
  })

  it('does not match network errors that are not chunk-load failures', () => {
    expect(looksLikeChunkError('Failed to fetch')).toBe(false)
    expect(looksLikeChunkError('NetworkError when attempting to fetch resource')).toBe(false)
  })

  it('handles null/undefined/empty input without throwing', () => {
    expect(looksLikeChunkError(undefined)).toBe(false)
    expect(looksLikeChunkError(null)).toBe(false)
    expect(looksLikeChunkError('')).toBe(false)
  })
})

describe('recentlyReloaded / markReloaded', () => {
  it('is false with no prior reload recorded', () => {
    expect(recentlyReloaded(fakeStorage())).toBe(false)
  })

  it('is true immediately after marking a reload', () => {
    const storage = fakeStorage()
    const now = 1_000_000
    markReloaded(storage, now)
    expect(recentlyReloaded(storage, now)).toBe(true)
  })

  it('stays true just inside the guard window', () => {
    const storage = fakeStorage()
    const now = 1_000_000
    markReloaded(storage, now)
    expect(recentlyReloaded(storage, now + RELOAD_GUARD_WINDOW_MS - 1)).toBe(true)
  })

  it('expires once the guard window has passed (so a later, unrelated failure can still recover)', () => {
    const storage = fakeStorage()
    const now = 1_000_000
    markReloaded(storage, now)
    expect(recentlyReloaded(storage, now + RELOAD_GUARD_WINDOW_MS + 1)).toBe(false)
  })

  it('treats a corrupt stored value as "no guard" rather than throwing', () => {
    const storage = fakeStorage({ [RELOAD_GUARD_KEY]: 'not-a-number' })
    expect(recentlyReloaded(storage)).toBe(false)
  })

  it('never throws when storage access itself throws (private-browsing style)', () => {
    const throwingStorage: ReloadGuardStorage = {
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => { throw new Error('storage disabled') },
    }
    expect(() => recentlyReloaded(throwingStorage)).not.toThrow()
    expect(recentlyReloaded(throwingStorage)).toBe(false)
    expect(() => markReloaded(throwingStorage)).not.toThrow()
  })
})
