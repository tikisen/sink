import { defineConfig } from '@playwright/test'

// e2e config for testing a real production-style build (hashed _nuxt/*
// chunks, exactly like what's deployed) rather than `nuxt dev`'s Vite
// dev-server module graph, which has no chunk hashing at all and so can't
// exercise chunk-load-failure scenarios (see tests/e2e/chunk-error-
// recovery.spec.ts). webServer builds once, then serves that build with
// wrangler dev (local D1/KV, no Cloudflare Access -- matches how every
// other local reproduction in this project works, see docs/plans/active/
// 2026-09-28-sink-shortener.md Phase 9/10).
const PORT = 8788

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `pnpm build && npx wrangler dev .output/server/index.mjs --assets .output/public --port ${PORT}`,
    url: `http://localhost:${PORT}/api/version`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? '',
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '78ae4e14e0daa32272309f84e40ef795',
    },
  },
})
