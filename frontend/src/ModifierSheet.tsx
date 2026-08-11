import { useState } from 'react'
import {
  money,
  type MenuItem,
  type Modifier,
  type PickedModifier,
} from './catalog'
import NumPad from './NumPad'

/**
 * 单道菜的加料 / 特殊要求。
 *
 * 目录里的加料**只传 id 不传价**：价格由服务端查目录。
 * 客户端传金额等于谁都能给自己打折 —— 这条规矩全项目一致。
 *
 * 手写要求是唯一的例外，和 Buffet To Go 按重量称同一类：
 * 那个数**本来就只存在于现场**，客人当场提的要求，价钱当场谈。
 * 所以它必须归属到人（sync_op 里带 user_id），事后查得到是谁定的。
 */
export default function ModifierSheet({
  item,
  modifiers,
  initial = [],
  initialQty = 1,
  onCancel,
  onConfirm,
}: {
  item: MenuItem
  modifiers: Modifier[]
  initial?: PickedModifier[]
  initialQty?: number
  onCancel: () => void
  onConfirm: (qty: number, picked: PickedModifier[]) => void
}) {
  const [qty, setQty] = useState(initialQty)
  const [ids, setIds] = useState<Set<number>>(
    () => new Set(initial.filter((p) => p.modifier_id !== undefined).map((p) => p.modifier_id!)),
  )
  // 手写的要求可以有多条（"不放花生" + "分两盘装"）
  const [custom, setCustom] = useState<{ label: string; price_cents: number }[]>(
    () => initial.filter((p) => p.modifier_id === undefined).map((p) => ({ label: p.label, price_cents: p.price_cents })),
  )
  const [draft, setDraft] = useState('')
  const [draftCents, setDraftCents] = useState(0)

  const chosen = modifiers.filter((m) => ids.has(m.id))
  // 加料按**份**算：点 2 份都加虾就是两份的钱。和服务端一致。
  const perDish =
    (item.price_cents ?? 0) +
    chosen.reduce((a, m) => a + m.price_cents, 0) +
    custom.reduce((a, c) => a + c.price_cents, 0)

  function build(): PickedModifier[] {
    return [
      // 目录里的：**不带价格**，服务端自己查
      ...chosen.map((m) => ({ modifier_id: m.id, label: m.name_zh, price_cents: m.price_cents })),
      ...custom.map((c) => ({ label: c.label, price_cents: c.price_cents })),
    ]
  }

  function addDraft() {
    const label = draft.trim()
    if (!label) return
    setCustom((c) => [...c, { label, price_cents: draftCents }])
    setDraft('')
    setDraftCents(0)
  }

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet mod-sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {item.name_zh}
          <span className="period-tag">{money(item.price_cents ?? 0)}</span>
        </h2>

        <div className="mod-split">
          <div className="mod-left">
            <div className="stepper">
              <button onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
              <span className="sl">
                份数
                <small>加料按份收，{qty} 份就是 {qty} 份的钱</small>
              </span>
              <span className="qty">{qty}</span>
              <button onClick={() => setQty((q) => q + 1)}>＋</button>
            </div>

            <h3 className="zone">常用要求</h3>
            <div className="mod-grid">
              {modifiers.map((m) => (
                <button
                  key={m.id}
                  className={ids.has(m.id) ? 'on' : ''}
                  onClick={() =>
                    setIds((s) => {
                      const n = new Set(s)
                      n.has(m.id) ? n.delete(m.id) : n.add(m.id)
                      return n
                    })
                  }
                >
                  <span className="m-name">{m.name_zh}</span>
                  {/* 免费的也把 0 写出来，不留空 —— 空着会被读成"没写价"，
                      员工得停下来想一秒 */}
                  <span className={`m-price${m.price_cents ? '' : ' free'}`}>
                    {m.price_cents ? `+${money(m.price_cents)}` : '免费'}
                  </span>
                </button>
              ))}
              {modifiers.length === 0 && (
                <p className="hint">还没有加载到加料目录，联网后再试。</p>
              )}
            </div>

            {custom.length > 0 && (
              <>
                <h3 className="zone">手写要求</h3>
                <div className="mod-custom-list">
                  {custom.map((c, i) => (
                    <div key={i} className="mod-custom">
                      <span className="cc-label">{c.label}</span>
                      <span className="cc-price">
                        {c.price_cents ? `+${money(c.price_cents)}` : '免费'}
                      </span>
                      <button
                        className="cc-del"
                        onClick={() => setCustom((x) => x.filter((_, j) => j !== i))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="mod-right">
            {/* 说明收在标签里且必须**放得下一行** ——
                换行就多 20px，而横屏矮屏上每一行都在跟键盘抢高度。
                怎么加价靠下面的键盘自明，不用写成一句话。 */}
            {/* 「加进」和输入框同一行。
                 放在键盘下面那版，横屏矮屏上它会被挤到滚动区外面 ——
                 而这一栏里唯一必须**永远看得见**的就是它。
                 按钮在 label 外面：放里面点它会顺带聚焦输入框，
                 iOS 上还会顶出系统键盘。 */}
            <div className="cust-block">
              <label className="reason">
                {/* ⚠️ 必须用一个 span 裹住。.reason 是 flex column，
                    <small> 直接放会变成独立的 flex item 自己占一行 ——
                    和宽度无关，多出来的 20px 全是从键盘那儿抢的。 */}
                <span>
                  自定义要求<small>　金额在下方输</small>
                </span>
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="例如：不放花生 / 分两盘装"
                />
              </label>
              <button className="cust-add" disabled={!draft.trim()} onClick={addDraft}>
                加进
              </button>
            </div>

            {/* 金额和「清空」并成一行。
                NumPad 自带的显示条(37px) + 清空行(42px) 是两条独立的行，
                加起来 80px 全是从按键那儿抢的 —— 横屏上按键因此被压到 34px，
                看着就像显示不全。这两样合并成 40px 一行，按键就回得来。
                NumPad 是三个页面共用的，所以不改它，只在这一栏里隐藏它自带的两行。 */}
            <div className="cust-amt">
              <span className="ca-val">{money(draftCents)}</span>
              <button className="ca-clear" onClick={() => setDraftCents(0)}>
                清空
              </button>
            </div>

            <NumPad value={draftCents} onChange={setDraftCents} />
          </div>
        </div>

        <div className="mod-total">
          <span>
            {money(perDish)} / 份 × {qty}
          </span>
          <strong>{money(perDish * qty)}</strong>
        </div>

        <div className="sheet-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            onClick={() => {
              // 输了一半没点"加进这道菜"就确认 —— 顺手带上，
              // 否则员工会以为记上了，其实丢了
              const extra = draft.trim()
                ? [{ label: draft.trim(), price_cents: draftCents }]
                : []
              onConfirm(qty, [...build(), ...extra])
            }}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}
