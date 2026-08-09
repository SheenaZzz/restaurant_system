import { useState } from 'react'
import { money } from './catalog'
import type { PayMethod, Payment } from './checks'
import type { LocalCheck } from './db'

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
  const [cash, setCash] = useState(check.pay_cash ?? 0)
  const [card, setCard] = useState(check.pay_card ?? 0)
  const [note, setNote] = useState(check.pay_note ?? '')
  const [busy, setBusy] = useState(false)

  const other = method === 'other' ? total : 0
  const entered = method === 'mixed' ? cash + card : method === 'cash' ? total : method === 'card' ? total : total
  const diff = entered - total

  const valid =
    method === 'other'
      ? note.trim().length > 0
      : method === 'mixed'
        ? cash > 0 && card > 0
        : true

  function build(): Payment {
    if (method === 'cash') return { method, cash_cents: total, card_cents: 0, other_cents: 0 }
    if (method === 'card') return { method, cash_cents: 0, card_cents: total, other_cents: 0 }
    if (method === 'other')
      return { method, cash_cents: 0, card_cents: 0, other_cents: total, note: note.trim() }
    return { method: 'mixed', cash_cents: cash, card_cents: card, other_cents: 0 }
  }

  return (
    <div className="sheet-back" onClick={onCancel}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {title} {check.table_label}
        </h2>

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

        {method === 'mixed' && (
          <>
            <MoneyRow label="现金" cents={cash} onChange={setCash} />
            <MoneyRow label="刷卡" cents={card} onChange={setCard} />
            <p className={`hint ${diff !== 0 ? 'warnText' : ''}`}>
              已填 {money(cash + card)} / 应收 {money(total)}
              {diff !== 0 && ` · 差 ${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}`}
            </p>
            <button
              className="linkbtn wide"
              onClick={() => setCard(Math.max(0, total - cash))}
            >
              剩余全部走刷卡
            </button>
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
        {other > 0 && null}
      </div>
    </div>
  )
}

function MoneyRow({
  label,
  cents,
  onChange,
}: {
  label: string
  cents: number
  onChange: (c: number) => void
}) {
  return (
    <label className="reason">
      {label}
      <input
        type="text"
        inputMode="decimal"
        value={(cents / 100).toFixed(2)}
        onChange={(e) => {
          const v = Math.round(Number(e.target.value.replace(/[^\d.]/g, '')) * 100)
          onChange(Number.isFinite(v) && v >= 0 ? v : 0)
        }}
      />
    </label>
  )
}
