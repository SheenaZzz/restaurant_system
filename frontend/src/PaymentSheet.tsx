import { useState } from 'react'
import { tr } from './i18n'
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
  /**
   * 这次要结的金额。不传 = 整张单的应收。
   *
   * 三种用法共用这一个弹层：
   *   结账（首次）   amount 省略 → 整单金额
   *   补收差额       amount = 待收    → **只录还没收的那部分**
   *   改支付方式     amount 省略 → 整单金额（整体替换）
   */
  amount,
  /** 补收模式下用来显示"应收 / 已收 / 待收"三行 */
  collected,
  onCancel,
  onConfirm,
}: {
  check: LocalCheck
  title: string
  amount?: number
  collected?: number
  onCancel: () => void
  onConfirm: (p: Payment) => void | Promise<void>
}) {
  // 这次要收的钱。补收时它是**差额**，不是整单金额 ——
  // 让员工对着 $62.46 去收那 $6.99，收错是迟早的事。
  const total = amount ?? check.est_cents
  const topUp = collected !== undefined && collected > 0
  const [method, setMethod] = useState<PayMethod>(
    // 补收时不预选上次的方式：上次刷卡不代表这次也刷卡，
    // 预选反而容易一路点过去记成错的方式
    topUp ? 'cash' : (check.pay_method ?? 'cash'),
  )

  /**
   * 混合支付只让人输**一边**，另一边永远是余额。
   *
   * 现场就是这样的："客人给了 50 现金，剩下刷卡"。
   * 让两边都能自由输入，只会制造"两边加起来对不上总额"这种脏数据 ——
   * 而那正是月报里「支付与账单不符」要抓的东西。从源头堵掉更好。
   */
  const [entrySide, setEntrySide] = useState<'cash' | 'card'>('cash')
  const [entered, setEntered] = useState(
    !topUp && check.pay_method === 'mixed' ? (check.pay_cash ?? 0) : 0,
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
      {topUp ? (
        // 补收时把三个数并排摆出来，员工才知道那个大数字是"还差多少"，
        // 而不是"这单多少钱"
        <table className="kv duebox">
          <tbody>
            <tr>
              <td className="dim">{tr('账单应收')}</td>
              <td className="num">{money(check.est_cents)}</td>
            </tr>
            <tr>
              <td className="dim">{tr('之前已收')}</td>
              <td className="num">{money(collected ?? 0)}</td>
            </tr>
            <tr>
              <td className="dim">{tr('本次待收')}</td>
              <td className="num strong">{money(total)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        check.service_cents > 0 && (
          <p className="hint">含大桌服务费 {money(check.service_cents)}（10%）</p>
        )
      )}

      <div className="paygrid">
        {METHODS.map((m) => (
          <button
            key={m.k}
            className={method === m.k ? 'on' : ''}
            onClick={() => setMethod(m.k)}
          >
            {tr(m.label)}
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
              <span className="sl">{tr('现金')} {entrySide === 'cash' ? tr('（输入中）') : ''}</span>
              <span className="sv">{money(cash)}</span>
            </button>
            <button
              className={entrySide === 'card' ? 'on' : ''}
              onClick={() => {
                if (entrySide !== 'card') setEntered(card)
                setEntrySide('card')
              }}
            >
              <span className="sl">{tr('刷卡')} {entrySide === 'card' ? tr('（输入中）') : ''}</span>
              <span className="sv">{money(card)}</span>
            </button>
          </div>
          <p className="hint">
            点上面切换输入哪一边，<b>{tr('另一边自动等于余额')}</b> —— 加起来永远等于{topUp ? '本次待收' : '应收'}。
          </p>
        </>
      )}

      {method === 'other' && (
        <label className="reason">
          {tr('说明（必填）')}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr('例如：gift card / 代金券')}
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
                  { label: tr('一半'), cents: Math.round(total / 2) },
                  { label: tr('全额'), cents: total },
                ]}
              />
            </div>
          </div>
        ) : (
          left
        )}

        <div className="sheet-actions">
          <button onClick={onCancel}>{tr('取消')}</button>
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
