import { timingSafeEqual } from 'node:crypto'

export default eventHandler(async (event) => {
  // /api/version identifies the deployed source (commit/tag, this fork's URL) for
  // AGPL corresponding-source purposes and carries no secrets — it stays
  // reachable without a token. It is deliberately excluded from the Cloudflare
  // Access application that gates the rest of /api/* (see docs/plans/active/
  // 2026-09-28-sink-shortener.md Phase 2.5), so it is genuinely public.
  if (event.path === '/api/version')
    return

  if (!event.path.startsWith('/api/'))
    return

  const token = getHeader(event, 'Authorization')?.replace(/^Bearer\s+/, '')
  if (await verifySiteToken(token, useRuntimeConfig(event).siteToken)) {
    event.context.authMethod = 'site-token'
    event.context.userID = 'root'
    event.context.userEmail = `root@${getRequestURL(event).hostname}`
    return
  }

  const access = await verifyCloudflareAccess(event)
  if (access) {
    if (!isCloudflareAccessRequestAllowed(event)) {
      throw createError({
        status: 403,
        statusText: 'Forbidden',
      })
    }

    // F33/F34: a restricted-scope audience (e.g. the Raycast/Hermes
    // automation app) only authenticates for its declared method+path
    // allowlist. Access already keeps its tokens off the broad Admin app at
    // the edge; this is the defense-in-depth check inside Sink itself.
    if (!isRequestAllowedByScope(access.scope, event.method, event.path)) {
      throw createError({
        status: 403,
        statusText: 'Forbidden: credential is not scoped for this operation',
      })
    }

    Object.assign(
      event.context,
      mapCloudflareAccessIdentity(access.identity, getRequestURL(event).hostname),
    )
    return
  }

  setResponseHeader(event, 'WWW-Authenticate', 'Bearer')

  if (token && token.length < 8) {
    throw createError({
      status: 401,
      statusText: 'Token is too short',
    })
  }

  throw createError({
    status: 401,
    statusText: 'Unauthorized',
  })
})

async function verifySiteToken(provided: string | undefined, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided || '')),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  return timingSafeEqual(new Uint8Array(providedHash), new Uint8Array(expectedHash))
}
