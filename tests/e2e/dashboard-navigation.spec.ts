import { expect, test } from '@playwright/test'

// Regression coverage for two reported bugs on the live dashboard
// (docs/plans/active/2026-09-28-sink-shortener.md, Round 4 follow-up):
//   1. Clicking the "History" nav item landed back on the Links page.
//   2. Clicking a link in the list threw an error.
//
// Root cause: this Worker was redeployed several times in quick
// succession; a browser tab left open (or a cached bundle) across a
// deploy holds JS referencing chunk hashes the CURRENT deployment's asset
// manifest no longer serves. Nuxt's own `nuxt:chunk-reload` plugin only
// recovers a failure that surfaces through Vue Router's onError channel
// (a lazy PAGE component failing to load during navigation) -- it does
// NOT catch a dynamic import failing from something loaded *after* a page
// has already resolved. Reproduced directly (see the plan for the
// investigation log): blocking a route's own newly-required chunk throws
// `TypeError: Failed to fetch dynamically imported module: ...`, exactly
// matching "throws an error"; a failure Vue Router's guard doesn't fully
// own can leave a navigation stuck on the previous route, matching
// "lands back on the Links page". Fix: app/plugins/chunk-error-reload.client.ts
// (window-level unhandledrejection/error listeners, not just router.onError).

const SITE_TOKEN = 'local-dev-test-token-not-for-production-use-only'

async function login(page: import('@playwright/test').Page) {
  await page.goto('/dashboard/login')
  await page.getByLabel(/token/i).fill(SITE_TOKEN)
  await page.getByRole('button', { name: /log in|sign in|submit/i }).click()
  await page.waitForURL('**/dashboard/**')
}

test.describe('chunk-error-reload plugin (unit-level, deterministic)', () => {
  test('recovers with a full reload when a chunk-load error is dispatched anywhere in the app', async ({ page }) => {
    await login(page)
    await page.goto('/dashboard/links')
    await page.waitForLoadState('networkidle')

    // A load event firing again is direct proof a real navigation/reload
    // happened -- not an assumption about internal plugin state.
    const reloaded = page.waitForEvent('load', { timeout: 5000 })

    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent('error', {
        message: 'TypeError: Failed to fetch dynamically imported module: https://example.test/_nuxt/deadbeef.js',
      }))
    })

    await expect(reloaded).resolves.toBeTruthy()
  })

  test('does not reload for an unrelated error', async ({ page }) => {
    await login(page)
    await page.goto('/dashboard/links')
    await page.waitForLoadState('networkidle')

    let reloadFired = false
    page.once('load', () => {
      reloadFired = true
    })

    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent('error', {
        message: 'TypeError: Cannot read properties of undefined (reading \'slug\')',
      }))
    })
    await page.waitForTimeout(1000)

    expect(reloadFired).toBe(false)
  })
})

test.describe('reported navigation bugs, end to end', () => {
  test('History nav reaches the History page and renders, even with its route chunk unreachable', async ({ page }) => {
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error')
        consoleErrors.push(msg.text())
    })
    page.on('pageerror', err => pageErrors.push(err.message))

    await login(page)
    await page.goto('/dashboard/links')
    await page.waitForLoadState('networkidle')

    // Freeze the set of chunks this fully-settled page already needed --
    // a normal, non-stale client would already have every one of these.
    const baseline = new Set<string>()
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('/_nuxt/') && url.endsWith('.js'))
        baseline.add(url)
    })
    await page.waitForTimeout(300)

    // Block only chunks NOT already loaded -- simulating exactly one thing:
    // the route-specific chunk a stale deployment's manifest no longer has.
    await page.route('**/_nuxt/*.js', async (route) => {
      if (baseline.has(route.request().url())) {
        await route.continue()
        return
      }
      await route.fulfill({ status: 404, body: 'Not Found' })
    })

    await page.getByRole('link', { name: /history/i }).first().click()
    await page.waitForTimeout(3000)

    expect(page.url()).toContain('/dashboard/history')
    await expect(page.getByText('Total Clicks')).toBeVisible({ timeout: 10000 })
  })

  test('clicking a link opens its detail view without a persisting error, even with its route chunk unreachable', async ({ page }) => {
    await login(page)
    await page.goto('/dashboard/links')
    await page.waitForLoadState('networkidle')

    const anchorCount = await page.locator('a[href*="/dashboard/link?"]').count()
    test.skip(anchorCount === 0, 'no links seeded in this environment')

    const targetHref = await page.locator('a[href*="/dashboard/link?"]').first().getAttribute('href')

    const baseline = new Set<string>()
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('/_nuxt/') && url.endsWith('.js'))
        baseline.add(url)
    })
    await page.waitForTimeout(300)

    await page.route('**/_nuxt/*.js', async (route) => {
      if (baseline.has(route.request().url())) {
        await route.continue()
        return
      }
      await route.fulfill({ status: 404, body: 'Not Found' })
    })

    await page.locator('a[href*="/dashboard/link?"]').first().click()
    await page.waitForTimeout(3500)

    expect(page.url()).toContain(targetHref!.split('?')[0])
    // The detail page always renders a "<slug>'s Stats" heading once the
    // link loads successfully -- an error state never shows this.
    await expect(page.getByText(/'s stats/i)).toBeVisible({ timeout: 10000 })
  })
})
