import { useEffect, useState } from 'react'
import { authFetch } from './auth'
import { refreshCatalog } from './catalog'

interface TaxRow {
  rate: number
  effective_from: string
  note: string | null
  updated_by: string | null
}

interface BusinessDayRow {
  tz: string
  business_day_cutoff_hour: number
  updated_by: string | null
  /** 按当前设置算出来的店内此刻时间（带偏移的 ISO） */
  store_now: string
  business_date: string
  choices: { tz: string; label: string }[]
}

/** 日界的可选值。0–5 覆盖所有真实餐馆；后端接受 0–23。 */
const CUTOFF_CHOICES: { h: number; label: string }[] = [
  { h: 0, label: '0 点整 —— 过午夜就是新的一天' },
  { h: 1, label: '凌晨 1 点' },
  { h: 2, label: '凌晨 2 点 —— 收市后补的单仍算前一天' },
  { h: 3, label: '凌晨 3 点' },
  { h: 4, label: '凌晨 4 点' },
  { h: 5, label: '凌晨 5 点' },
]

/**
 * 设置：营业日/时区 + 销售税率。
 *
 * **一年点不到几次**，所以入口是头部一个小齿轮，不占主界面。
 * 但这两项都确实会需要改（县里调税率、时区当初设错），
 * 写死在代码里改一次就得重新发版、重建容器 —— 店里没有 IT。
 */
export default function SettingsSheet({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState<TaxRow | null>(null)
  const [percent, setPercent] = useState('')
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [bd, setBd] = useState<BusinessDayRow | null>(null)
  const [tz, setTz] = useState('')
  const [cutoff, setCutoff] = useState(0)
  const [bdBusy, setBdBusy] = useState(false)
  const [bdMsg, setBdMsg] = useState<string | null>(null)

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

    authFetch('/api/reports/business-day')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: BusinessDayRow | null) => {
        if (!d) return
        setBd(d)
        setTz(d.tz)
        setCutoff(d.business_day_cutoff_hour)
      })
      .catch(() => setErr('需要联网才能读取设置'))
  }, [])

  const dirty =
    bd !== null && (tz !== bd.tz || cutoff !== bd.business_day_cutoff_hour)

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <h3 className="zone">营业日与时区</h3>

        {bd ? (
          <>
            {/* 把店内此刻时间显示出来 —— 时区选错了，这一行一眼就不对，
                比任何校验提示都直观 */}
            <p className="hint">
              店内此刻：<b>{storeClockText(bd.store_now)}</b>
              <br />
              当前营业日：<b>{bd.business_date}</b>
              {bd.updated_by && ` · 由 ${bd.updated_by} 设定`}
            </p>

            <label className="reason">
              时区
              <select value={tz} onChange={(e) => setTz(e.target.value)}>
                {bd.choices.map((c) => (
                  <option key={c.tz} value={c.tz}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="reason">
              营业日从几点开始
              <select
                value={cutoff}
                onChange={(e) => setCutoff(Number(e.target.value))}
              >
                {CUTOFF_CHOICES.map((c) => (
                  <option key={c.h} value={c.h}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <p className="hint">
              时区决定<b>午市/晚市怎么切</b>（15:00 分界）和
              <b>账单算哪一天</b>。设错了会按错误的时段收价 ——
              午市 $14.05、晚市 $15.88。
            </p>

            <p className="hint warnbox">
              ⚠️ 改时区<b>没有生效日，是全局改的</b>，和税率不一样。
              税率是事实（那天就是按 7.1% 收的，历史账单必须冻住）；
              时区是<b>解释规则</b>，回答「这个时间点算哪一天」——
              设错了就该连过去的账一起重新归属，否则等于把错误永远冻在历史里。
              <br />
              直接后果：<b>月报里靠近日界的账单可能会换一天。</b>
            </p>

            {bdMsg && <p className="hint">{bdMsg}</p>}

            <button
              className="linkbtn wide"
              disabled={bdBusy || !dirty}
              onClick={async () => {
                setBdBusy(true)
                setErr(null)
                setBdMsg(null)
                try {
                  const res = await authFetch('/api/reports/business-day', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      tz,
                      business_day_cutoff_hour: cutoff,
                    }),
                  })
                  if (!res.ok) throw new Error(String(res.status))
                  const d: BusinessDayRow = await res.json()
                  setBd(d)
                  setTz(d.tz)
                  setCutoff(d.business_day_cutoff_hour)
                  // 前端的营业日口径是从 catalog 拿的 —— 不刷新的话
                  // 清单页还会按旧的分界切，和月报对不上
                  await refreshCatalog()
                  setBdMsg(`已保存。店内此刻 ${storeClockText(d.store_now)}。`)
                } catch {
                  setErr('保存失败，检查网络后重试')
                } finally {
                  setBdBusy(false)
                }
              }}
            >
              {bdBusy ? '保存中…' : dirty ? '保存营业日设置' : '未改动'}
            </button>
          </>
        ) : (
          <p className="hint">需要联网才能读取营业日设置。</p>
        )}

        <div className="divider" />

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
          税收在<b>小计 + 大桌服务费</b>上。
          <br />
          改税率会<b>新增一条生效记录</b>，不会动已经开过的账单 ——
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

/**
 * 显示店内时间。
 *
 * ⚠️ 不能直接 toLocaleString() —— 那会按**这台设备**的时区显示，
 *    而这一行的全部意义就是让人看见**店里**的时间对不对。
 *    服务端给的是带偏移的 ISO，手动按那个偏移取字段。
 */
function storeClockText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso)
  if (!m) return iso
  const [, y, mo, d, hh, mm] = m
  return `${Number(mo)}月${Number(d)}日 ${hh}:${mm}（${y}）`
}
