import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

interface HandledValidationError {
  statusCode: 400
  statusMessage: 'Validation Error'
  data: {
    issues: unknown[]
    name: 'ZodError'
    stack: string
  }
}

function isHandledValidationError(error: unknown): error is HandledValidationError {
  if (typeof error !== 'object' || error === null
    || !('statusCode' in error) || error.statusCode !== 400
    || !('statusMessage' in error) || error.statusMessage !== 'Validation Error'
    || !('data' in error) || typeof error.data !== 'object' || error.data === null) {
    return false
  }

  const { data } = error
  return 'issues' in data && Array.isArray(data.issues)
    && 'name' in data && data.name === 'ZodError'
    && 'stack' in data && typeof data.stack === 'string'
    && data.stack.includes('validateData')
}

export default defineConfig(async ({ mode }) => ({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      miniflare: {
        cf: true,
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./drizzle'),
        },
      },
    }),
  ],
  test: {
    env: loadEnv(mode, process.cwd(), ''),
    isolate: false,
    maxWorkers: 1,
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10_000,
    // tests/e2e/** are @playwright/test specs (a real browser against a
    // built, deployed-style server via `pnpm test:e2e`) -- running them
    // through vitest's Cloudflare Workers pool crashes the shared worker
    // (discovered adding tests/e2e/dashboard-navigation.spec.ts: vitest's
    // default include glob picked it up, Playwright's `test`/`expect`
    // aren't vitest's, and the whole run aborted partway with "Worker
    // exited unexpectedly").
    exclude: ['**/node_modules/**', '**/tests/e2e/**'],
    onUnhandledError(error) {
      return !isHandledValidationError(error)
    },
  },
}))
