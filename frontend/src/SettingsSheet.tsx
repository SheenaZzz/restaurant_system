import { useEffect, useState } from 'react'
import { getLang, catLabel, tr } from './i18n'
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
  choices: { tz: string; label: string; label_en?: string }[]
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
  // ⚠️ 不要用 new Date().toISOString().slice(0,10) —— 那是 **UTC 日期**。
  //    店在 UTC-7，晚上 17:00 之后 UTC 就已经是第二天了，默认生效日
  //    会悄悄跑到明天。改用服务端下发的营业日（GET 回来之后填）。
  const [from, setFrom] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const [bd, setBd] = useState<BusinessDayRow | null>(null)
  const [tz, setTz] = useState('')
  const [cutoff, setCutoff] = useState(0)

  useEffect(() => {
    authFetch('/api/reports/tax')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TaxRow | null) => {
        setCur(d)
        if (d) {
          setPercent(taxPercentText(d.rate))
          setFrom(d.effective_from)
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
        // 税率的生效日默认取**店里的营业日**，不是设备日期也不是 UTC 日期
        setFrom((f) => f || d.business_date)
      })
      .catch(() => setErr('需要联网才能读取设置'))
  }, [])

  const bdDirty =
    bd !== null && (tz !== bd.tz || cutoff !== bd.business_day_cutoff_hour)

  // 税率只有在真的改过时才提交。
  // ⚠️ 这里曾经出过一次真实事故：界面上有两个保存按钮，显眼的那个
  //    只存税率。用户改了时区、点了底部的「保存」—— 时区没存上，
  //    却凭空多出一条生效日是明天的税率记录（税率还没变）。
  //    现在只有一个保存按钮，且逐节判断有没有改动。
  const taxDirty = cur
    ? percent.trim() !== taxPercentText(cur.rate) ||
      from !== cur.effective_from ||
      note.trim() !== (cur.note ?? '')
    : percent.trim() !== ''

  const dirty = bdDirty || taxDirty

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('设置')}</h2>

        <h3 className="zone">{tr('营业日与时区')}</h3>

        {bd ? (
          <>
            {/* 把店内此刻时间显示出来 —— 时区选错了，这一行一眼就不对，
                比任何校验提示都直观 */}
            <p className="hint">
              {tr('店内此刻')} <b>{storeClockText(bd.store_now)}</b>
              <br />
              {tr('当前营业日')} <b>{bd.business_date}</b>
              {bd.updated_by && ` · ${tr('由')} ${tr(bd.updated_by)} ${tr('设定')}`}
            </p>

            <label className="reason">
              {tr('时区')}
              <select value={tz} onChange={(e) => setTz(e.target.value)}>
                {bd.choices.map((c) => (
                  <option key={c.tz} value={c.tz}>
                    {catLabel(c)}
                  </option>
                ))}
              </select>
            </label>

            <label className="reason">
              {tr('营业日从几点开始')}
              <select
                value={cutoff}
                onChange={(e) => setCutoff(Number(e.target.value))}
              >
                {CUTOFF_CHOICES.map((c) => (
                  <option key={c.h} value={c.h}>
                    {tr(c.label)}
                  </option>
                ))}
              </select>
            </label>

            <p className="hint">
              {tr('时区决定午市/晚市怎么切（15:00 分界）和账单算哪一天。设错了会按错误的时段收价。')}
            </p>

            <p className="hint warnbox">
              {tr('⚠️ 改时区是全局生效的，没有生效日 —— 月报里靠近日界的账单可能会换一天。')}
            </p>

          </>
        ) : (
          <p className="hint">{tr('需要联网才能读取营业日设置。')}</p>
        )}

        <div className="divider" />

        <h3 className="zone">{tr('销售税率')}</h3>

        {cur ? (
          <p className="hint">
            <b>{taxPercentText(cur.rate)}%</b> · {tr('自')} {cur.effective_from}
            {cur.updated_by && ` · ${tr('由')} ${tr(cur.updated_by)} ${tr('设定')}`}
            {cur.note && ` · ${cur.note}`}
          </p>
        ) : (
          <p className="hint">{tr('还没有设过税率，当前按 0% 计。')}</p>
        )}

        <label className="reason">
          {tr('税率（%）')}
          <input
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            inputMode="decimal"
            placeholder={tr('例如 7.1')}
          />
        </label>

        <label className="reason">
          {tr('生效日期')}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>

        <label className="reason">
          {tr('备注（可选）')}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr('例如：县里调率')}
          />
        </label>

        <p className="hint">
          {tr('税收在小计 + 大桌服务费上。改税率是新增一条生效记录，已经开过的账单不受影响。')}
        </p>

        {err && <p className="err">{err}</p>}
        {msg && <p className="hint">{msg}</p>}

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('关闭')}</button>
          {/* **只有一个保存按钮**，管这一页所有改动。
              两个按钮那版出过事：改了时区、点了这里，结果存的是税率。 */}
          <button
            className="primary"
            disabled={busy || !dirty}
            onClick={async () => {
              setErr(null)
              setMsg(null)

              const v = Number(percent)
              if (taxDirty && (!percent.trim() || !Number.isFinite(v) || v < 0 || v >= 100)) {
                setErr('税率不合法')
                return
              }
              if (taxDirty && !from) {
                setErr('请选择税率的生效日期')
                return
              }

              setBusy(true)
              const done: string[] = []
              try {
                if (bdDirty) {
                  const res = await authFetch('/api/reports/business-day', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tz, business_day_cutoff_hour: cutoff }),
                  })
                  if (!res.ok) throw new Error(String(res.status))
                  const d: BusinessDayRow = await res.json()
                  setBd(d)
                  setTz(d.tz)
                  setCutoff(d.business_day_cutoff_hour)
                  done.push(tr('时区与营业日'))
                }

                if (taxDirty) {
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
                  done.push('销售税率（新开的账单起生效）')
                }

                // 营业日口径和税率都由 catalog 下发给前端 —— 不刷新的话
                // 清单页还按旧的分界切、本地估价还用旧税率，和月报对不上
                await refreshCatalog()
                setMsg(`已保存：${done.join('；')}`)
              } catch {
                setErr('保存失败，检查网络后重试')
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? tr('保存中…') : dirty ? tr('保存') : tr('未改动')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 0.071 → '7.1'。去掉尾零，别让设置页显示 '7.100%'。 */
function taxPercentText(rate: number): string {
  return (rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
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
  // 用店里的偏移手动取字段（不能 toLocaleString —— 那会按**设备**时区显示，
  // 而这一行的全部意义就是让人看见**店里**的时间）。
  // 月份名跟着语言走，别在英文界面里写「8月11日」。
  if (getLang() === 'zh') return `${Number(mo)}月${Number(d)}日 ${hh}:${mm}（${y}）`
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${MON[Number(mo) - 1]} ${Number(d)}, ${hh}:${mm} (${y})`
}
