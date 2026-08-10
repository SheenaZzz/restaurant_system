import { useState } from 'react'
import { money } from './catalog'
import type { PayMethod, Payment } from './checks'
import type { LocalCheck } from './db'
import NumPad from './NumPad'

const METHODS: { k: PayMethod; label: string }[] = [
  { k: 'cash', label: '现金' },
  { k: 'card', label: '刷卡' },
  { k: 'mixed', label: '现金+刷卡' },
  { k: 'other', label: '其它' },
]

/**
 * 支付方式录入。
 *
 * ⚠️ 系统**不处理收款** —— 这里只是记录客人用什么方式付的。
 * 之所以非记不可：日结时唯一的交叉验证就是拿它对卡机和钱箱。
 * 不分方式的话，差了 30 块也不知道差在现金还是卡上。
 *
 * 混合支付时用**左右分栏**：左边金额和选择，右边键盘。
 * 竖着排会把弹层撑满整屏，确认按钮被挤到屏幕外，还得滚动才能点 ——
 * 高峰期结账多滚一下都是多余动作。
 */
export default function PaymentSheet({
  check,
  title,
  onCancel,
  onConfirm,
}: {
  check: LocalCheck
  title: string
  onCancel: () => void
  onConfirm: (p: Payment) => void | Promise<void>
}) {
  const total = check.est_cents
  const [method, setMethod] = useState<PayMethod>(check.pay_method ?? 'cash')

  /**
   * 混合支付只让人输**一边**，另一边永远是余额。
   *
   * 现场就是这样的："客人给了 50 现金，剩下刷卡"。
   * 让两边都能自由输入，只会制造"两边加起来对不上总额"这种脏数据 ——
   * 而那正是月报里「支付与账单不符」要抓的东西。从源头堵掉更好。
   */
  const [entrySide, setEntrySide] = useState<'cash' | 'card'>('cash')
  const [entered, setEntered] = useState(
    check.pay_method === 'mixed' ? (check.pay_cash ?? 0) : 0,
  )
  const [note, setNote] = useState(check.pay_note ?? '')
  const [busy, setBusy] = useState(false)

  const rest = Math.max(0, total - entered)
  const cash = entrySide === 'cash' ? entered : rest
  const card = entrySide === 'cash' ? rest : entered
  const mixed = method === 'mixed'

  const valid =
    method === 'other'
      ? note.trim().length > 0
      : mixed
        ? entered > 0 && entered < total
        : true

  function build(): Payment {
    if (method === 'cash')
      return { method, cash_cents: total, card_cents: 0, other_cents: 0 }
    if (method === 'card')
      return { method, cash_cents: 0, card_cents: total, other_cents: 0 }
    if (method === 'other')
      return {
        method,
        cash_cents: 0,
        card_cents: 0,
        other_cents: total,
        note: note.trim(),
      }
    return { method: 'mixed', cash_cents: cash, card_cents: card, other_cents: 0 }
  }

  const left = (
    <div className="pay-left">
      <p className="total">{money(total)}</p>
      {check.service_cents > 0 && (
        <p className="hint">含大桌服务费 {money(check.service_cents)}（10%）</p>
      )}

      <div className="paygrid">
        {METHODS.map((m) => (
          <button
            key={m.k}
            className={method === m.k ? 'on' : ''}
            onClick={() => setMethod(m.k)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mixed && (
        <>
          <div className="splitrow">
            <button
              className={entrySide === 'cash' ? 'on' : ''}
              onClick={() => {
                // 换一边输入时把当前余额接过去，数字不会跳
                if (entrySide !== 'cash') setEntered(cash)
                setEntrySide('cash')
              }}
            >
              <span className="sl">现金 {entrySide === 'cash' ? '（输入中）' : ''}</span>
              <span className="sv">{money(cash)}</span>
            </button>
            <button
              className={entrySide === 'card' ? 'on' : ''}
              onClick={() => {
                if (entrySide !== 'card') setEntered(card)
                setEntrySide('card')
              }}
            >
              <span className="sl">刷卡 {entrySide === 'card' ? '（输入中）' : ''}</span>
              <span className="sv">{money(card)}</span>
            </button>
          </div>
          <p className="hint">
            点上面切换输入哪一边，**另一边自动等于余额** —— 加起来永远等于应收。
          </p>
        </>
      )}

      {method === 'other' && (
        <label className="reason">
          说明（必填）
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：gift card / 代金券"
            autoFocus
          />
        </label>
      )}
    </div>
  )

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div
        className={`sheet${mixed ? ' pay-wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>
          {title} {check.table_label}
        </h2>

        {mixed ? (
          <div className="pay-split">
            {left}
            <div className="pay-right">
              <NumPad
                value={entered}
                onChange={setEntered}
                max={total}
                quick={[
                  { label: '一半', cents: Math.round(total / 2) },
                  { label: '全额', cents: total },
                ]}
              />
            </div>
          </div>
        ) : (
          left
        )}

        <div className="sheet-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            disabled={busy || !valid}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(build())
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? '…' : '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
