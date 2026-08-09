import { useState } from 'react'
import { login, type Identity } from './auth'

export default function LoginPage({ onDone }: { onDone: (id: Identity) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      onDone(await login(username.trim(), password))
    } catch (e) {
      // 离线时 fetch 直接抛错 —— 要说清楚是连不上，
      // 否则员工会以为是自己密码记错了
      setErr(
        e instanceof Error && e.message.includes('Failed to fetch')
          ? '连不上服务器（检查店内 WiFi）'
          : e instanceof Error
            ? e.message
            : '登录失败',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>餐馆运营系统</h1>

        <label>
          账号
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="username"
            required
          />
        </label>

        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {err && <p className="err">{err}</p>}

        <button type="submit" disabled={busy || !username || !password}>
          {busy ? '登录中…' : '登录'}
        </button>

        <p className="hint">
          开发账号：front / kitchen / admin，密码 <code>&lt;账号&gt;-dev-pw</code>
        </p>
      </form>
    </div>
  )
}
