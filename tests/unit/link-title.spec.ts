import { describe, expect, it, vi } from 'vitest'
import {
  decodeHtmlEntities,
  extractTitleFromHtml,
  fetchPageTitle,
  normalizePageTitle,
  TITLE_FETCH_MAX_BYTES,
  TITLE_FETCH_MAX_REDIRECTS,
  TITLE_MAX_LENGTH,
} from '../../server/utils/link-title'

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  })
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  })
}

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry &lt;3&gt;')).toBe('Tom & Jerry <3>')
  })

  it('decodes numeric and hex entities', () => {
    expect(decodeHtmlEntities('caf&#233; &#x2014; fancy')).toBe('café — fancy')
  })

  it('leaves unknown entities untouched', () => {
    expect(decodeHtmlEntities('&notreal; stays')).toBe('&notreal; stays')
  })
})

describe('normalizePageTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizePageTitle('  Hello \n\n  World  ')).toBe('Hello World')
  })

  it('decodes entities before collapsing', () => {
    expect(normalizePageTitle('Fish &amp;   Chips')).toBe('Fish & Chips')
  })

  it('truncates to 256 characters', () => {
    const long = 'x'.repeat(500)
    const result = normalizePageTitle(long)
    expect(result).toHaveLength(TITLE_MAX_LENGTH)
  })
})

describe('extractTitleFromHtml', () => {
  it('prefers og:title over <title>', () => {
    const html = `<html><head><meta property="og:title" content="OG Title"><title>Doc Title</title></head></html>`
    expect(extractTitleFromHtml(html)).toBe('OG Title')
  })

  it('handles reversed attribute order on the og:title meta tag', () => {
    const html = `<meta content="Reversed OG" property="og:title">`
    expect(extractTitleFromHtml(html)).toBe('Reversed OG')
  })

  it('falls back to <title> when there is no og:title', () => {
    const html = `<html><head><title>Only A Title</title></head></html>`
    expect(extractTitleFromHtml(html)).toBe('Only A Title')
  })

  it('returns undefined when neither is present', () => {
    expect(extractTitleFromHtml('<html><body>no title here</body></html>')).toBeUndefined()
  })

  it('ignores an empty og:title content and falls back to <title>', () => {
    const html = `<meta property="og:title" content=""><title>Fallback</title>`
    expect(extractTitleFromHtml(html)).toBe('Fallback')
  })
})

describe('fetchPageTitle', () => {
  it('extracts and normalizes a title from a simple 200 response', async () => {
    const fetcher = vi.fn(async () => htmlResponse('<title>Example Domain</title>'))
    const title = await fetchPageTitle('https://example.com/', { fetcher })
    expect(title).toBe('Example Domain')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('sends a manual-redirect request with the abort signal attached', async () => {
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return htmlResponse('<title>Signal Checked</title>')
    })
    await fetchPageTitle('https://example.com/', { fetcher })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('follows up to 3 redirects and extracts the final title', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url === 'https://example.com/1')
        return redirectResponse('https://example.com/2')
      if (url === 'https://example.com/2')
        return redirectResponse('https://example.com/3')
      if (url === 'https://example.com/3')
        return redirectResponse('https://example.com/4')
      if (url === 'https://example.com/4')
        return htmlResponse('<title>Landed</title>')
      throw new Error(`unexpected url: ${url}`)
    })
    const title = await fetchPageTitle('https://example.com/1', { fetcher })
    expect(title).toBe('Landed')
    expect(fetcher).toHaveBeenCalledTimes(TITLE_FETCH_MAX_REDIRECTS + 1)
  })

  it('gives up after more than 3 redirects', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const n = Number(String(input).split('/').pop())
      return redirectResponse(`https://example.com/${n + 1}`)
    })
    const title = await fetchPageTitle('https://example.com/1', { fetcher })
    expect(title).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(TITLE_FETCH_MAX_REDIRECTS + 1)
  })

  it('rejects non-http(s) protocols without calling the fetcher', async () => {
    const fetcher = vi.fn(async () => htmlResponse('<title>should not happen</title>'))
    expect(await fetchPageTitle('javascript:alert(1)', { fetcher })).toBeUndefined()
    expect(await fetchPageTitle('file:///etc/passwd', { fetcher })).toBeUndefined()
    expect(await fetchPageTitle('data:text/html,<title>x</title>', { fetcher })).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects a redirect that leaves http(s)', async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input) === 'https://example.com/')
        return redirectResponse('javascript:alert(1)')
      throw new Error('should not be called again')
    })
    expect(await fetchPageTitle('https://example.com/', { fetcher })).toBeUndefined()
  })

  it('returns undefined on invalid input URLs', async () => {
    const fetcher = vi.fn()
    expect(await fetchPageTitle('not a url', { fetcher })).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns undefined for a non-2xx response', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 }))
    expect(await fetchPageTitle('https://example.com/', { fetcher })).toBeUndefined()
  })

  it('returns undefined for a non-HTML content type', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    expect(await fetchPageTitle('https://example.com/', { fetcher })).toBeUndefined()
  })

  it('returns undefined when the page has no title', async () => {
    const fetcher = vi.fn(async () => htmlResponse('<html><body>nothing</body></html>'))
    expect(await fetchPageTitle('https://example.com/', { fetcher })).toBeUndefined()
  })

  it('never throws when the fetcher rejects (e.g. timeout/abort)', async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    await expect(fetchPageTitle('https://example.com/', { fetcher })).resolves.toBeUndefined()
  })

  it('caps the response body at TITLE_FETCH_MAX_BYTES and ignores content beyond it', async () => {
    const padding = 'x'.repeat(TITLE_FETCH_MAX_BYTES + 1024)
    // The title tag sits entirely past the byte cap, so it must never be seen.
    const html = `<html><head>${padding}<title>Should Not Be Seen</title></head></html>`
    const fetcher = vi.fn(async () => htmlResponse(html))
    const title = await fetchPageTitle('https://example.com/', { fetcher })
    expect(title).toBeUndefined()
  })

  it('finds a title that sits within the byte cap even in a large document', async () => {
    const padding = 'x'.repeat(1024)
    const html = `<html><head><title>Within Cap</title>${padding}</head><body>${'y'.repeat(TITLE_FETCH_MAX_BYTES)}</body></html>`
    const fetcher = vi.fn(async () => htmlResponse(html))
    const title = await fetchPageTitle('https://example.com/', { fetcher })
    expect(title).toBe('Within Cap')
  })
})
