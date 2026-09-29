defineRouteMeta({
  openAPI: {
    description: 'Identifies the exact deployed source (fork URL, commit, deploy tag) for AGPL corresponding-source purposes. Public — no auth required, no secrets returned.',
    responses: {
      200: { description: 'Deployed source metadata' },
    },
  },
})

/**
 * F27 (docs/reviews/2026-09-28-sink-shortener.rev2.codex-review.md): the
 * upstream /api/verify route reports Sink's own project URL, not the running
 * fork's commit — so it can't answer "what source is this instance running".
 * This route does. `public.deployCommit` / `public.deployTag` are baked at
 * build time by the deploy script from `git rev-parse HEAD` and the
 * `deploy-YYYYMMDD-N` tag; they are empty only for a local `pnpm dev` build
 * that never ran that script.
 */
export default eventHandler((event) => {
  const { deployCommit, deployTag } = useRuntimeConfig(event).public

  return {
    fork: true,
    sourceUrl: 'https://github.com/tikisen/sink',
    upstream: 'https://github.com/miantiao-me/Sink',
    commit: deployCommit || null,
    tag: deployTag || null,
  }
})
