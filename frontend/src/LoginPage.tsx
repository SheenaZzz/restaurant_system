import { useState } from 'react'
import { tr } from './i18n'
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
      // fetch throws outright when offline -- say it cannot reach the server,
      // or staff assume they mistyped the password
      setErr(
        e instanceof Error && e.message.includes('Failed to fetch')
          ? tr('Cannot reach the server (check the store WiFi)')
          : e instanceof Error
            ? tr(e.message)
            : tr('Sign-in failed'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>{tr('Restaurant Operations')}</h1>

        <label>
          {tr('Account')}
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
          {tr('Password')}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {err && <p className="err">{err}</p>}

        {/* This used to print the development accounts and the password rule.
            A sign-in page in a shop cannot say that -- the account list lives in
            RUNBOOK.md, which is for whoever runs the thing, not for the floor. */}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? tr('Signing in…') : tr('Sign in')}
        </button>
      </form>
    </div>
  )
}
