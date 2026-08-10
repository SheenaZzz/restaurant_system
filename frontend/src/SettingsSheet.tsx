import { useEffect, useState } from 'react'
import { authFetch } from './auth'
import { refreshCatalog } from './catalog'

interface TaxRow {
  rate: number
  effective_from: string
  note: string | null
  updated_by: string | null
}

/**
 * 设置。目前只有税率。
 *
 * **设一次基本不用再动**，所以入口放在头部一个小齿轮里，不占主界面。
 * 但税率确实会变（州/县调整），所以必须留改的口子 ——
 * 把它写死在代码里，改一次就得重新发版，那才是真麻烦。
 */
export default function SettingsSheet({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState<TaxRow | null>(null)
  const [percent, setPercent] = useState('')
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    authFetch('/api/reports/tax')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TaxRow | null) => {
        setCur(d)
        if (d) {
          setPercent((d.rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, ''))
          setNote(d.note ?? '')
        }
      })
      .catch(() => setErr('需要联网才能读取设置'))
  }, [])

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <h3 className="zone">销售税率</h3>

        {cur ? (
          <p className="hint">
            当前：<b>{(cur.rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%</b>
            ，自 {cur.effective_from} 起
            {cur.updated_by && ` · 由 ${cur.updated_by} 设定`}
            {cur.note && ` · ${cur.note}`}
          </p>
        ) : (
          <p className="hint">还没有设过税率，当前按 0% 计。</p>
        )}

        <label className="reason">
          税率（%）
          <input
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            inputMode="decimal"
            placeholder="例如 7.1"
          />
        </label>

        <label className="reason">
          生效日期
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>

        <label className="reason">
          备注（可选）
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：县里调率"
          />
        </label>

        <p className="hint">
          税收在**小计 + 大桌服务费**上。
          <br />
          改税率会**新增一条生效记录**，不会动已经开过的账单 ——
          历史账单永远按当时的税率算，否则以前的票和账就对不上了。
        </p>

        {err && <p className="err">{err}</p>}
        {msg && <p className="hint">{msg}</p>}

        <div className="sheet-actions">
          <button onClick={onClose}>关闭</button>
          <button
            className="primary"
            disabled={busy || !percent.trim()}
            onClick={async () => {
              const v = Number(percent)
              if (!Number.isFinite(v) || v < 0 || v >= 100) {
                setErr('税率不合法')
                return
              }
              setBusy(true)
              setErr(null)
              setMsg(null)
              try {
                const res = await authFetch('/api/reports/tax', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    rate_percent: v,
                    effective_from: from,
                    note: note.trim() || null,
                  }),
                })
                if (!res.ok) throw new Error(String(res.status))
                setCur(await res.json())
                // 让本地估算立刻用上新税率
                await refreshCatalog()
                setMsg('已保存。新开的账单会用新税率。')
              } catch {
                setErr('保存失败，检查网络后重试')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
