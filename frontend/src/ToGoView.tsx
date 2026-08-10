import { useCallback, useEffect, useState } from 'react'
import type { Role } from './auth'
import { loadCatalog, money, refreshCatalog, type Catalog } from './catalog'
import {
  allChecks,
  openTogo,
  pendingCheckUuids,
  type NewLine,
} from './checks'
import CheckDetail, { PAY_LABEL, STATUS_LABEL } from './CheckDetail'
import type { LocalCheck } from './db'
import MenuPicker, { TogoAmountSheet } from './MenuPicker'

/**
 * 自提。和楼面分开是因为它**根本没有桌位这个概念** ——
 * 硬塞进楼面网格只会让人去找"这单在哪张桌上"。
 */
export default function ToGoView({ role }: { role: Role }) {
  const [cat, setCat] = useState<Catalog | null>(null)
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [sheet, setSheet] = useState<'buffet' | 'phone' | null>(null)
  const [phoneLines, setPhoneLines] = useState<NewLine[] | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [pick, setPick] = useState<LocalCheck | null>(null)

  const reload = useCallback(async () => {
    const all = await allChecks()
    setRows(all.filter((r) => r.source !== 'dine_in'))
    setPending(await pendingCheckUuids())
    setPick((p) => (p ? (all.find((r) => r.check_uuid === p.check_uuid) ?? null) : null))
  }, [])

  useEffect(() => {
    loadCatalog().then(setCat)
    refreshCatalog().then((c) => c && setCat(c))
    void reload()
    const t = window.setInterval(reload, 2000)
    return () => window.clearInterval(t)
  }, [reload])

  if (!cat) return <p className="hint">首次使用需要联网加载一次菜单…</p>

  const togoItem = cat.menu.find((m) => m.open_price)
  const openOnes = rows.filter((r) => r.status === 'open')

  return (
    <>
      <div className="togo-actions">
        <button
          className="bigcard buffet"
          disabled={!togoItem}
          onClick={() => setSheet('buffet')}
        >
          <span className="bc-title">自助餐打包</span>
          <span className="bc-sub">Buffet To Go · 按重量，直接录金额</span>
        </button>
        <button className="bigcard phone" onClick={() => setSheet('phone')}>
          <span className="bc-title">电话点菜</span>
          <span className="bc-sub">从菜单点，客人到店自提</span>
        </button>
      </div>

      <p className="hint">
        自提单不占桌，也**不收大桌服务费** —— 服务费只按堂食人头算。
      </p>

      <h3 className="zone">未取 {openOnes.length} 单</h3>

      <div className="cards">
        {rows.map((c) => (
          <button
            key={c.check_uuid}
            className={`card ${c.status}`}
            onClick={() => setPick(c)}
          >
            <div className="c-top">
              <span className="c-table">
                {c.source === 'buffet_togo' ? '打包' : '电话'}
              </span>
              <span
                className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}
              >
                {STATUS_LABEL[c.status]}
              </span>
              {pending.has(c.check_uuid) && <span className="tag warn">未上传</span>}
              <span className="grow" />
              <span className="c-time">
                {new Date(c.opened_at).toLocaleTimeString('zh-CN', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>

            <div className="c-money">{money(c.est_cents)}</div>

            {(c.customer_name || c.phone_last4) && (
              <div className="c-line">
                {c.customer_name && <span className="chip">{c.customer_name}</span>}
                {c.phone_last4 && <span className="chip">尾号 {c.phone_last4}</span>}
              </div>
            )}

            <div className="c-line">
              {(c.lines ?? []).slice(0, 3).map((l, i) => (
                <span key={i} className="chip">
                  {l.name}
                  {l.qty > 1 && ` ×${l.qty}`}
                </span>
              ))}
              {(c.lines ?? []).length > 3 && (
                <span className="chip">+{(c.lines ?? []).length - 3}</span>
              )}
            </div>

            <div className="c-foot">
              <span>{c.pay_method ? PAY_LABEL[c.pay_method] : '未记支付'}</span>
              <span className="grow" />
              <span>{c.by ?? '—'}</span>
            </div>
          </button>
        ))}
        {rows.length === 0 && <p className="hint">还没有自提单。</p>}
      </div>

      {sheet === 'buffet' && togoItem && (
        <TogoAmountSheet
          item={togoItem}
          onCancel={() => setSheet(null)}
          onConfirm={async (lines) => {
            await openTogo('buffet_togo', lines)
            setSheet(null)
            await reload()
          }}
        />
      )}

      {sheet === 'phone' && !phoneLines && (
        <MenuPicker
          menu={cat.menu}
          categories={cat.categories}
          title="电话点菜"
          onCancel={() => setSheet(null)}
          onConfirm={(lines) => {
            setPhoneLines(lines)
            setName('')
            setPhone('')
          }}
        />
      )}

      {/* 点完菜再问客人信息 —— 反过来会让人在电话里干等 */}
      {sheet === 'phone' && phoneLines && (
        <div className="sheet-back" onClick={() => setPhoneLines(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>客人信息</h2>
            <p className="hint">
              都可以留空。**手机号只存后四位** —— 够核对身份就行，不多收。
            </p>
            <label className="reason">
              姓名
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <label className="reason">
              手机号（只取后四位）
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <div className="sheet-actions">
              <button onClick={() => setPhoneLines(null)}>返回改菜</button>
              <button
                className="primary"
                onClick={async () => {
                  await openTogo('phone_order', phoneLines, {
                    name: name.trim() || undefined,
                    phone: phone.trim() || undefined,
                  })
                  setPhoneLines(null)
                  setSheet(null)
                  await reload()
                }}
              >
                建单
              </button>
            </div>
          </div>
        </div>
      )}

      {pick && (
        <CheckDetail
          check={pick}
          role={role}
          prices={cat.prices}
          period={cat.current_period_kind}
          openChecks={[]}
          menu={cat.menu}
          categories={cat.categories}
          pending={pending.has(pick.check_uuid)}
          onClose={() => setPick(null)}
          onChanged={reload}
        />
      )}
    </>
  )
}
