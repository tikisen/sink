import { describe, expect, it } from 'vitest'
import { fetch } from '../utils'

describe('/api/version', () => {
  it('is public: no auth header required', async () => {
    const response = await fetch('/api/version')
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.fork).toBe(true)
    expect(data.sourceUrl).toBe('https://github.com/tikisen/sink')
  })

  it('stays public even with a query string (event.path includes the query string — pathname must be compared instead)', async () => {
    const response = await fetch('/api/version?probe=1')
    expect(response.status).toBe(200)
  })
})
