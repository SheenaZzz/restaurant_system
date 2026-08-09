import { clientId, getMeta, setMeta } from './db'

export type Role = 'front' | 'kitchen' | 'admin'

export interface Identity {
  username: string
  display_name: string
  role: Role
}

interface Tokens {
  access: string
  refresh: string
  /** access token 的本地过期时刻（毫秒时间戳） */
  access_exp: number
}

/**
 * 令牌存 IndexedDB，不存 httpOnly cookie。
 *
 * 权衡：cookie 更抗 XSS，但这个 App 必须在**完全离线**时也能启动并
 * 渲染出正确的角色界面 —— 需要能读到身份信息，cookie 读不了。
 * 加上它只在店内内网跑、没有第三方脚本，XSS 面很小。
 * 换成公网多租户产品的话，这个取舍要重做。
 */
const K_TOKENS = 'auth_tokens'
const K_IDENTITY = 'auth_identity'

/** 提前 60 秒续期，避免请求正好卡在过期边界 */
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
    throw new Error(res.status === 401 ? '用户名或密码错误' : `登录失败 (${res.status})`)
  }
  const data = await res.json()
  await saveSession(data)
  return { username: data.username, display_name: data.display_name, role: data.role }
}

/**
 * 登出**只清凭证，不动 outbox**。
 * 未同步的记录属于店里，不属于这次登录会话 —— 换个人登进来照样要发出去。
 * 清掉它们等于丢单。
 */
export async function logout(): Promise<void> {
  const t = await getTokens()
  if (t) {
    // 尽力通知服务端作废；离线时失败也无所谓，本地清掉即可
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

/** 用 refresh token 换一套新的。并发调用只会真正执行一次。 */
async function doRefresh(): Promise<boolean> {
  const t = await getTokens()
  if (!t) return false

  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: t.refresh }),
  })

  if (!res.ok) {
    // 401 = 会话真的失效了，清掉逼用户重新登录。
    // 其它状态码（5xx / 网络问题）不能清 —— 那只是暂时的，
    // 清了会让离线的员工凭空被登出。
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
 * 带认证的 fetch。
 *
 * - 快过期就先续期
 * - 真的 401 了再续一次并重试一遍（令牌可能被服务端提前作废）
 * - **离线时照常抛错**，交给上层当作"排队"处理，不要在这里吞掉
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let t = await getTokens()
  if (!t) throw new Error('未登录')

  if (Date.now() > t.access_exp - REFRESH_MARGIN) {
    await refreshTokens()
    t = await getTokens()
    if (!t) throw new Error('会话已失效')
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
