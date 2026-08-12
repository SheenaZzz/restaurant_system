import { clientId, getMeta, setMeta } from './db'

export type Role = 'front_employee' | 'front_manager' | 'kitchen' | 'admin'

/** Roles that may edit and void -- this is UI gating only; the real check is server-side */
export function canManage(role: Role): boolean {
  return role === 'front_manager' || role === 'admin'
}

/** Roles that see the floor */
export function isFront(role: Role): boolean {
  return role !== 'kitchen'
}

export interface Identity {
  username: string
  display_name: string
  role: Role
}

interface Tokens {
  access: string
  refresh: string
  /** When the access token expires locally (ms timestamp) */
  access_exp: number
}

/**
 * Tokens live in IndexedDB, not an httpOnly cookie.
 *
 * The trade: a cookie resists XSS better, but this app has to start **fully
 * offline** and render the right role, which means reading the identity -- and a
 * cookie cannot be read.
 * On top of that it only runs on the store's own network with no third-party scripts, so the XSS surface is small.
 * For a public multi-tenant product this trade would have to be made again.
 */
const K_TOKENS = 'auth_tokens'
const K_IDENTITY = 'auth_identity'

/** Refresh 60 seconds early, so a request cannot land exactly on the expiry */
const REFRESH_MARGIN = 60_000

let cached: Tokens | null = null

export async function getIdentity(): Promise<Identity | null> {
  return getMeta<Identity | null>(K_IDENTITY, null)
}

async function getTokens(): Promise<Tokens | null> {
  if (cached) return cached
  cached = await getMeta<Tokens | null>(K_TOKENS, null)
  return cached
}

async function saveSession(data: {
  access_token: string
  refresh_token: string
  expires_in: number
  username: string
  display_name: string
  role: Role
}) {
  cached = {
    access: data.access_token,
    refresh: data.refresh_token,
    access_exp: Date.now() + data.expires_in * 1000,
  }
  await setMeta(K_TOKENS, cached)
  await setMeta(K_IDENTITY, {
    username: data.username,
    display_name: data.display_name,
    role: data.role,
  } satisfies Identity)
}

export async function login(username: string, password: string): Promise<Identity> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, client_id: await clientId() }),
  })
  if (!res.ok) {
    throw new Error(res.status === 401 ? 'Wrong username or password' : `Sign-in failed (${res.status})`)
  }
  const data = await res.json()
  await saveSession(data)
  return { username: data.username, display_name: data.display_name, role: data.role }
}

/**
 * Signing out **only clears credentials; the outbox is untouched**.
 * Unsynced records belong to the store, not to this session -- whoever signs in
 * next still has to send them. Clearing them is losing checks.
 */
export async function logout(): Promise<void> {
  const t = await getTokens()
  if (t) {
    // Best effort to tell the server; failing while offline is fine, clearing locally is enough
    await fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: t.refresh }),
    }).catch(() => {})
  }
  cached = null
  await setMeta(K_TOKENS, null)
  await setMeta(K_IDENTITY, null)
}

let refreshing: Promise<boolean> | null = null

/** Exchange the refresh token for a new pair. Concurrent calls only do it once. */
async function doRefresh(): Promise<boolean> {
  const t = await getTokens()
  if (!t) return false

  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: t.refresh }),
  })

  if (!res.ok) {
    // 401 = the session really is gone, so clear it and force a sign-in.
    // Any other status (5xx, network) must not clear -- that is temporary, and
    // clearing would sign an offline server out for no reason.
    if (res.status === 401) {
      cached = null
      await setMeta(K_TOKENS, null)
      await setMeta(K_IDENTITY, null)
    }
    return false
  }

  await saveSession(await res.json())
  return true
}

async function refreshTokens(): Promise<boolean> {
  if (!refreshing) {
    refreshing = doRefresh().finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

/**
 * fetch with authentication.
 *
 * - refresh first if it is about to expire
 * - on a real 401, refresh once more and retry (the server may have revoked the token early)
 * - **still throws when offline**, leaving the caller to treat it as queued rather than swallowing it here
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let t = await getTokens()
  if (!t) throw new Error('Not signed in')

  if (Date.now() > t.access_exp - REFRESH_MARGIN) {
    await refreshTokens()
    t = await getTokens()
    if (!t) throw new Error('Session expired')
  }

  const withAuth = (token: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  })

  let res = await fetch(input, withAuth(t.access))
  if (res.status === 401) {
    if (await refreshTokens()) {
      const t2 = await getTokens()
      if (t2) res = await fetch(input, withAuth(t2.access))
    }
  }
  return res
}

export async function isLoggedIn(): Promise<boolean> {
  return (await getTokens()) !== null
}


/**
 * Refresh the identity from the server.
 *
 * A role can change server-side (a member of staff becomes a manager). The
 * cached identity is a snapshot from sign-in, and without refreshing the front
 * end keeps rendering the old role.
 *
 * ⚠️ This only affects **what is displayed**. Authorisation is always decided
 * server-side -- a stale cache at worst shows the wrong button, and tapping it is still refused.
 */
export async function refreshIdentity(): Promise<Identity | null> {
  try {
    const res = await authFetch('/api/auth/me')
    if (!res.ok) return getIdentity()
    const me = await res.json()
    const id: Identity = {
      username: me.username,
      display_name: me.display_name,
      role: me.role,
    }
    await setMeta(K_IDENTITY, id)
    return id
  } catch {
    return getIdentity() // offline, use the cache
  }
}
