/**
 * Server-side page-title extraction for links created without one.
 *
 * Deliberately NOT the AI-based server/api/link/og-ai.get.ts path (which
 * needs the Workers AI binding and is user-triggered from the editor) --
 * this is a plain, dependency-free HTML title fetch that runs automatically
 * and fire-and-forget on link creation (see scheduleLinkTitleExtraction in
 * link-processing.ts). Every limit below is a deliberate safety bound for
 * background code running against an arbitrary user-supplied URL:
 *   - http/https only (no file:, data:, javascript:, etc.)
 *   - 5s total timeout (one AbortController across every hop)
 *   - 512 KB response body cap (a title is always near the top of <head>)
 *   - at most 3 redirects followed
 * This function never throws -- any failure (network, timeout, no title
 * found, oversized/non-HTML response) resolves to undefined, and the caller
 * never blocks link creation on it.
 */

export const TITLE_FETCH_TIMEOUT_MS = 5_000
export const TITLE_FETCH_MAX_BYTES = 512 * 1024
export const TITLE_FETCH_MAX_REDIRECTS = 3
export const TITLE_MAX_LENGTH = 256

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type TitleFetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface FetchPageTitleOptions {
  fetcher?: TitleFetcher
}

function isFetchableProtocol(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader)
    return (await response.text()).slice(0, maxBytes)

  const decoder = new TextDecoder()
  let received = 0
  let result = ''
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read()
      if (done)
        break
      received += value.byteLength
      result += decoder.decode(value, { stream: true })
    }
  }
  finally {
    await reader.cancel().catch(() => {})
  }
  return result
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: '\'',
  nbsp: ' ',
}

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X'
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF)
        return match
      try {
        return String.fromCodePoint(codePoint)
      }
      catch {
        return match
      }
    }
    return NAMED_HTML_ENTITIES[entity.toLowerCase()] ?? match
  })
}

export function normalizePageTitle(raw: string): string {
  const decoded = decodeHtmlEntities(raw)
  const collapsed = decoded.replace(/\s+/g, ' ').trim()
  return collapsed.slice(0, TITLE_MAX_LENGTH)
}

function extractOgTitle(html: string): string | undefined {
  // og:title's property/content attribute order is not fixed in the wild.
  const metaTagPattern = /<meta\b[^>]*>/gi
  for (const [tag] of html.matchAll(metaTagPattern)) {
    if (!/property=["']og:title["']/i.test(tag))
      continue
    const contentMatch = tag.match(/content=["']([^"']*)["']/i)
    if (contentMatch?.[1]?.trim())
      return contentMatch[1]
  }
  return undefined
}

function extractDocumentTitle(html: string): string | undefined {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return titleMatch?.[1]?.trim() || undefined
}

export function extractTitleFromHtml(html: string): string | undefined {
  return extractOgTitle(html) ?? extractDocumentTitle(html)
}

/**
 * Fetches `url` and returns a normalized page title, or undefined on any
 * failure. Never throws.
 */
export async function fetchPageTitle(url: string, options: FetchPageTitleOptions = {}): Promise<string | undefined> {
  const fetcher = options.fetcher ?? fetch
  let current: URL
  try {
    current = new URL(url)
  }
  catch {
    return undefined
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TITLE_FETCH_TIMEOUT_MS)

  try {
    for (let hop = 0; hop <= TITLE_FETCH_MAX_REDIRECTS; hop++) {
      if (!isFetchableProtocol(current))
        return undefined

      let response: Response
      try {
        response = await fetcher(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.1' },
        })
      }
      catch {
        return undefined
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {})
        const location = response.headers.get('location')
        if (!location)
          return undefined
        try {
          current = new URL(location, current)
        }
        catch {
          return undefined
        }
        continue
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return undefined
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType && !contentType.includes('html')) {
        await response.body?.cancel().catch(() => {})
        return undefined
      }

      const html = await readBodyCapped(response, TITLE_FETCH_MAX_BYTES)
      const rawTitle = extractTitleFromHtml(html)
      if (!rawTitle)
        return undefined
      const normalized = normalizePageTitle(rawTitle)
      return normalized || undefined
    }
    return undefined
  }
  catch {
    return undefined
  }
  finally {
    clearTimeout(timeout)
  }
}
