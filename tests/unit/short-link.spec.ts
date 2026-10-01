import { describe, expect, it } from 'vitest'
import { buildShortUrl, parseShortDomains, resolveShortDomain } from '../../shared/utils/short-link'

const ctx = { shortDomain: 'tqtold.me', fallbackOrigin: 'https://links.senkungu.com' }

describe('buildShortUrl', () => {
  it('uses the configured public short domain, not the request origin', () => {
    expect(buildShortUrl({ slug: 'abc' }, ctx)).toBe('https://tqtold.me/abc')
  })

  it('uses the link\'s own domain override when set', () => {
    expect(buildShortUrl({ slug: '4NIRX', domain: 'tqtold.us' }, ctx)).toBe('https://tqtold.us/4NIRX')
    expect(buildShortUrl({ slug: 'dmskincare', domain: 'bb.drmomsoffice.com' }, ctx)).toBe('https://bb.drmomsoffice.com/dmskincare')
  })

  it('treats a null/empty override as "use the default"', () => {
    expect(buildShortUrl({ slug: 'abc', domain: null }, ctx)).toBe('https://tqtold.me/abc')
    expect(buildShortUrl({ slug: 'abc', domain: '  ' }, ctx)).toBe('https://tqtold.me/abc')
  })

  it('falls back to the request origin when nothing is configured (upstream behavior)', () => {
    expect(buildShortUrl({ slug: 'abc' }, { fallbackOrigin: 'http://localhost' })).toBe('http://localhost/abc')
    expect(buildShortUrl({ slug: 'abc' }, { shortDomain: '', fallbackOrigin: 'http://localhost' })).toBe('http://localhost/abc')
  })

  it('an override still wins when no default is configured', () => {
    expect(buildShortUrl({ slug: 'x', domain: 'tqtold.us' }, { fallbackOrigin: 'http://localhost' })).toBe('https://tqtold.us/x')
  })
})

describe('resolveShortDomain / parseShortDomains', () => {
  it('resolves override > default > empty, lowercased', () => {
    expect(resolveShortDomain('TQTOLD.us', 'tqtold.me')).toBe('tqtold.us')
    expect(resolveShortDomain(undefined, 'tqtold.me')).toBe('tqtold.me')
    expect(resolveShortDomain(undefined, undefined)).toBe('')
  })

  it('parses a comma list, trimming and dropping blanks', () => {
    expect(parseShortDomains(' tqtold.me, tqtold.us ,,bb.drmomsoffice.com ')).toEqual(['tqtold.me', 'tqtold.us', 'bb.drmomsoffice.com'])
    expect(parseShortDomains(undefined)).toEqual([])
  })
})
