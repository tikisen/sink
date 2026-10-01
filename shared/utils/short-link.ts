/**
 * Short-link display URL. The public short domain is configured
 * (NUXT_PUBLIC_SHORT_DOMAIN) rather than derived from the request host, because
 * the dashboard/API live on a different host (links.senkungu.com) than the
 * domains the links are actually shared on (tqtold.me, tqtold.us, ...).
 * Resolution order: the link's own `domain` override, the configured default,
 * then the request origin (an unconfigured deployment keeps upstream behavior).
 */
export interface ShortLinkContext {
  /** Configured default public short domain (NUXT_PUBLIC_SHORT_DOMAIN), '' when unset. */
  shortDomain?: string
  /** Fallback origin, e.g. 'https://links.senkungu.com', used only when no domain applies. */
  fallbackOrigin: string
}

export function resolveShortDomain(linkDomain: string | undefined | null, shortDomain?: string): string {
  return (linkDomain?.trim() || shortDomain?.trim() || '').toLowerCase()
}

export function buildShortUrl(link: { slug: string, domain?: string | null }, context: ShortLinkContext): string {
  const domain = resolveShortDomain(link.domain, context.shortDomain)
  return `${domain ? `https://${domain}` : context.fallbackOrigin}/${link.slug}`
}

/** Parses NUXT_PUBLIC_SHORT_DOMAINS ("a.com, b.com") into the allowed domain list. */
export function parseShortDomains(raw: string | undefined | null): string[] {
  return (raw ?? '').split(',').map(domain => domain.trim().toLowerCase()).filter(Boolean)
}
