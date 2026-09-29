import type { H3Event } from 'h3'
import type { JWTVerifyGetKey } from 'jose'
import { createRemoteJWKSet, jwtVerify } from 'jose'

interface CloudflareAccessConfig {
  audience: string
  issuer: string
}

export type CloudflareAccessIdentity
  = | {
    kind: 'user'
    userID: string
    userEmail: string
  }
  | {
    kind: 'service'
  }

export type CloudflareAccessAuth
  = | {
    authMethod: 'access-user'
    userID: string
    userEmail: string
  }
  | {
    authMethod: 'access-service'
    userID: 'root'
    userEmail: string
  }

const jwksByTeamDomain = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getAccessTokens(event: H3Event): string[] {
  return [...new Set([
    getHeader(event, 'Cf-Access-Jwt-Assertion'),
    getCookie(event, 'CF_Authorization'),
  ].filter((token): token is string => !!token))]
}

function getJwks(teamDomain: string) {
  const cachedJwks = jwksByTeamDomain.get(teamDomain)
  if (cachedJwks)
    return cachedJwks

  const certsUrl = new URL('/cdn-cgi/access/certs', `${teamDomain}/`)
  const jwks = createRemoteJWKSet(certsUrl)
  jwksByTeamDomain.set(teamDomain, jwks)
  return jwks
}

export async function verifyCloudflareAccessToken(
  token: string,
  config: CloudflareAccessConfig,
  getKey?: JWTVerifyGetKey,
): Promise<CloudflareAccessIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, getKey || getJwks(config.issuer), {
      algorithms: ['RS256'],
      audience: config.audience,
      issuer: config.issuer,
      requiredClaims: ['exp'],
    })

    if (payload.type !== 'app')
      return null

    const userID = typeof payload.sub === 'string' ? payload.sub.trim() : ''
    const userEmail = typeof payload.email === 'string' ? payload.email.trim() : ''
    const commonName = typeof payload.common_name === 'string' ? payload.common_name.trim() : ''

    if (userID && userEmail && payload.common_name === undefined) {
      return {
        kind: 'user',
        userID,
        userEmail,
      }
    }

    if (payload.sub === '' && payload.email === undefined && commonName) {
      return {
        kind: 'service',
      }
    }

    return null
  }
  catch {
    return null
  }
}

export function mapCloudflareAccessIdentity(
  identity: CloudflareAccessIdentity,
  hostname: string,
): CloudflareAccessAuth {
  if (identity.kind === 'user') {
    return {
      authMethod: 'access-user',
      userID: identity.userID,
      userEmail: identity.userEmail,
    }
  }

  return {
    authMethod: 'access-service',
    userID: 'root',
    userEmail: `root@${hostname}`,
  }
}

/**
 * F33/F34: a request can authenticate against the broad Admin Access
 * application (full API surface, matching Sink's original design) OR
 * against a narrower, separately-configured Access application whose own
 * audience only covers a declared allowlist of exact method+path pairs.
 * `AccessScope` records which one matched so the caller (server/middleware/
 * 2.auth.ts) can enforce that allowlist — Access already restricts which
 * PATH can even reach the narrow app's policies at the edge, but Sink must
 * still recognize that audience at all (a single hard-coded `cfAccessAud`
 * check rejects every other audience outright) and must still refuse an
 * out-of-allowlist method/path if it ever reaches Sink some other way.
 */
export interface AccessScopeRule {
  method: string
  path: string
}

export type AccessScope
  = | { kind: 'admin' }
    | { kind: 'restricted', name: string, allow: AccessScopeRule[] }

interface ScopedAudienceConfig {
  audience: string
  name: string
  allow: AccessScopeRule[]
}

function isAccessScopeRule(value: unknown): value is AccessScopeRule {
  return !!value && typeof value === 'object'
    && typeof (value as Record<string, unknown>).method === 'string'
    && typeof (value as Record<string, unknown>).path === 'string'
}

/**
 * Parses NUXT_CF_ACCESS_SCOPED_AUDS. Malformed/empty input yields no scoped
 * audiences — never throws, never silently grants admin scope.
 *
 * Takes `unknown`, not `string`: Nitro's Cloudflare-preset runtime-config
 * merge runs every Worker var through `destr` (smart-parse: a value that
 * looks like JSON becomes real JSON) before handing it to
 * `useRuntimeConfig(event)`. A JSON-array-shaped var — exactly this one —
 * therefore arrives as an already-parsed array, not a string, even though
 * the actual Cloudflare binding is `plain_text`. Confirmed live: a bare
 * `typeof cfAccessScopedAuds === 'string'` check failed in production while
 * `JSON.parse(json)` on the very same string worked perfectly in isolation.
 */
export function parseScopedAudiences(input: unknown): ScopedAudienceConfig[] {
  if (input === undefined || input === null || input === '')
    return []
  try {
    const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input
    if (!Array.isArray(parsed))
      return []
    return parsed.filter((entry): entry is ScopedAudienceConfig =>
      !!entry
      && typeof entry.audience === 'string' && entry.audience.trim().length > 0
      && typeof entry.name === 'string' && entry.name.trim().length > 0
      && Array.isArray(entry.allow) && entry.allow.length > 0 && entry.allow.every(isAccessScopeRule))
  }
  catch {
    return []
  }
}

/** Exact method (case-insensitive) + exact path match — no prefix/wildcard matching, so the allowlist can't accidentally widen. */
export function isRequestAllowedByScope(scope: AccessScope, method: string, path: string): boolean {
  if (scope.kind === 'admin')
    return true
  return scope.allow.some(rule => rule.method.toUpperCase() === method.toUpperCase() && rule.path === path)
}

export async function verifyCloudflareAccess(event: H3Event): Promise<{ identity: CloudflareAccessIdentity, scope: AccessScope } | null> {
  const { cfAccessTeamDomain, cfAccessAud, cfAccessScopedAuds } = useRuntimeConfig(event)
  const issuer = cfAccessTeamDomain.trim().replace(/\/+$/, '')
  if (!issuer)
    return null

  const candidates: Array<{ audience: string, scope: AccessScope }> = []
  const adminAudience = cfAccessAud.trim()
  if (adminAudience)
    candidates.push({ audience: adminAudience, scope: { kind: 'admin' } })
  for (const scoped of parseScopedAudiences(cfAccessScopedAuds))
    candidates.push({ audience: scoped.audience, scope: { kind: 'restricted', name: scoped.name, allow: scoped.allow } })

  if (!candidates.length)
    return null

  for (const token of getAccessTokens(event)) {
    for (const candidate of candidates) {
      const identity = await verifyCloudflareAccessToken(token, { audience: candidate.audience, issuer })
      if (identity)
        return { identity, scope: candidate.scope }
    }
  }

  return null
}

export function isCloudflareAccessConfigured(teamDomain: string, audience: string): boolean {
  return !!teamDomain.trim() && !!audience.trim()
}

export function isCloudflareAccessRequestAllowed(event: H3Event): boolean {
  return isCloudflareAccessRequestSafe({
    method: event.method,
    hasAccessCookie: !!getCookie(event, 'CF_Authorization'),
    origin: getHeader(event, 'Origin'),
    requestOrigin: getRequestURL(event).origin,
    secFetchSite: getHeader(event, 'Sec-Fetch-Site'),
  })
}

interface CloudflareAccessRequest {
  method: string
  hasAccessCookie?: boolean
  origin?: string
  requestOrigin: string
  secFetchSite?: string
}

export function isCloudflareAccessRequestSafe(request: CloudflareAccessRequest): boolean {
  if (request.secFetchSite === 'cross-site')
    return false

  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method))
    return true

  if (request.origin)
    return request.origin === request.requestOrigin

  return !request.hasAccessCookie
}
