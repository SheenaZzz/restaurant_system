import { useState } from 'react'
import { canManage, type Role } from './auth'
import {
  money,
  type Category,
  type Drinks,
  type MenuItem,
  type PriceRow,
} from './catalog'
import {
  addLines,
  closeWithPayment,
  mergeTables,
  modifyTable,
  restoreTable,
  transferTable,
  updatePayment,
  voidTable,
  type Guests,
  type Payment,
} from './checks'
import type { LocalCheck } from './db'
import CheckHistory from './CheckHistory'
import MenuPicker from './MenuPicker'
import EditSheet from './EditSheet'
import PaymentSheet from './PaymentSheet'
import TransferSheet from './TransferSheet'

export const STATUS_LABEL: Record<LocalCheck['status'], string> = {
  open: '未结',
  closed: '已结',
  voided: '已作废',
  merged: '已并入',
}

export const PAY_LABEL: Record<string, string> = {
  cash: '现金',
  card: '刷卡',
  mixed: '现金+刷卡',
  other: '其它',
}

/**
 * 账单详情 + 全部操作。
 *
 * 楼面和清单页共用同一个组件 —— 各写一遍的话，两边的按钮可见性、
 * 权限判断、二次确认迟早会不一致，而不一致的地方总是出现在
 * "只有一边处理了"的那个分支上。
 */
export default function CheckDetail({
  check,
  role,
  prices,
  period,
  openChecks,
  menu,
  categories,
  pending = false,
  onClose,
  onChanged,
}: {
  check: LocalCheck
  role: Role
  prices: PriceRow[]
  period: 'lunch' | 'dinner'
  /** 其它未结账单，供并桌选择 */
  openChecks: LocalCheck[]
  /** 菜单，用于加菜。不传就不显示加菜按钮 */
  menu?: MenuItem[]
  categories?: Category[]
  /** 这张单还有操作没上传到服务端 */
  pending?: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const [sub, setSub] = useState<
    'pay' | 'move' | 'edit' | 'void' | 'history' | 'addlines' | null
  >(null)
  const [reason, setReason] = useState('')
  const manage = canManage(role)
  const c = check

  async function done() {
    setSub(null)
    await onChanged()
    onClose()
  }

  if (sub === 'pay') {
    return (
      <PaymentSheet
        check={c}
        title={c.status === 'open' ? '结账' : '改支付方式'}
        onCancel={() => setSub(null)}
        onConfirm={async (p: Payment) => {
          if (c.status === 'open') await closeWithPayment(c.check_uuid, p)
          else await updatePayment(c.check_uuid, p)
          await done()
        }}
      />
    )
  }

  if (sub === 'move') {
    return (
      <TransferSheet
        check={c}
        others={openChecks.filter((o) => o.check_uuid !== c.check_uuid)}
        onCancel={() => setSub(null)}
        onTransfer={async (label) => {
          await transferTable(c.check_uuid, label)
          await done()
        }}
        onMerge={async (uuids) => {
          await mergeTables(c.check_uuid, uuids)
          await done()
        }}
      />
    )
  }

  if (sub === 'edit') {
    return (
      <EditSheet
        check={c}
        prices={prices}
        period={period}
        onCancel={() => setSub(null)}
        onConfirm={async (guests: Guests, drinks: Drinks) => {
          await modifyTable(c.check_uuid, guests, drinks)
          await done()
        }}
      />
    )
  }

  if (sub === 'addlines' && menu && categories) {
    return (
      <MenuPicker
        menu={menu}
        categories={categories}
        title={`${c.table_label} 加菜`}
        onCancel={() => setSub(null)}
        onConfirm={async (lines) => {
          await addLines(c.check_uuid, lines)
          await done()
        }}
      />
    )
  }

  if (sub === 'history') {
    return (
      <CheckHistory
        checkUuid={c.check_uuid}
        tableLabel={c.table_label}
        onClose={() => setSub(null)}
      />
    )
  }

  if (sub === 'void') {
    return (
      <div className="sheet-back" onClick={() => setSub(null)}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <h2>作废 {c.table_label}</h2>
          <p className="total">{money(c.est_cents)}</p>
          <p className="hint">
            作废会把这单从营业额里剔除，必须填写原因，会记录操作人。
            作废后可以随时「恢复」。
            {c.status === 'closed' && ' 恢复后仍是已结账状态，结账时间不变。'}
          </p>
          <label className="reason">
            原因
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例如：客人取消 / 录错桌号"
              autoFocus
            />
          </label>
          <div className="sheet-actions">
            <button onClick={() => setSub(null)}>取消</button>
            <button
              className="primary danger"
              disabled={!reason.trim()}
              onClick={async () => {
                await voidTable(c.check_uuid, reason.trim())
                await done()
              }}
            >
              确认作废
            </button>
          </div>
        </div>
      </div>
    )
  }

  const guests = c.adult + c.child + c.senior
  const drinks = c.drink_adult + c.drink_child

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>
          {c.table_label}
          <span className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}>
            {STATUS_LABEL[c.status]}
          </span>
          {pending && <span className="tag warn">未上传</span>}
        </h2>

        <table className="kv">
          <tbody>
            <tr>
              <td className="dim">开台</td>
              <td className="num">
                {new Date(c.opened_at).toLocaleString('zh-CN', { hour12: false })}
              </td>
            </tr>
            <tr>
              <td className="dim">Buffet 人数</td>
              <td className="num">
                {guests
                  ? `${guests}（成 ${c.adult} · 童 ${c.child} · 长 ${c.senior}）`
                  : '—'}
              </td>
            </tr>
            <tr>
              <td className="dim">饮料</td>
              <td className="num">
                {drinks ? `${drinks}（成 ${c.drink_adult} · 童 ${c.drink_child}）` : '—'}
              </td>
            </tr>
            {c.service_cents > 0 && (
              <tr>
                <td className="dim">大桌服务费 10%</td>
                <td className="num">{money(c.service_cents)}</td>
              </tr>
            )}
            {(c.tax_cents ?? 0) > 0 && (
              <tr>
                <td className="dim">税</td>
                <td className="num">{money(c.tax_cents)}</td>
              </tr>
            )}
            <tr>
              <td className="dim">支付方式</td>
              <td className="num">
                {c.pay_method ? PAY_LABEL[c.pay_method] : '未记录'}
                {c.pay_method === 'mixed' &&
                  `（现 ${money(c.pay_cash ?? 0)} / 卡 ${money(c.pay_card ?? 0)}）`}
                {c.pay_note && ` · ${c.pay_note}`}
              </td>
            </tr>
            {(c.customer_name || c.phone_last4) && (
              <tr>
                <td className="dim">客人</td>
                <td className="num">
                  {c.customer_name ?? '—'}
                  {c.phone_last4 && ` · 尾号 ${c.phone_last4}`}
                </td>
              </tr>
            )}
            <tr>
              <td className="dim">操作人</td>
              <td className="num">{operatorText(c)}</td>
            </tr>
            {c.void_reason && (
              <tr>
                <td className="dim">作废原因</td>
                <td className="num badText">{c.void_reason}</td>
              </tr>
            )}
          </tbody>
        </table>

        {(c.lines ?? []).length > 0 && (
          <>
            <div className="divider" />
            <table className="kv lines">
              <tbody>
                {(c.lines ?? []).map((l, i) => (
                  <tr key={i} className={l.voided ? 'voided' : ''}>
                    <td>
                      {l.name}
                      {l.qty > 1 && <span className="dim"> ×{l.qty}</span>}
                      {l.notes && <div className="dim small">{l.notes}</div>}
                    </td>
                    <td className="num">{money(l.qty * l.unit_price_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <p className="total">{money(c.est_cents)}</p>

        {pending && (
          <p className="hint">
            这张单还有改动**只存在这台 iPad 上**，没传到服务器。
            联网后会自动补发，不用做任何操作。
          </p>
        )}

        <div className="actiongrid">
          {menu && categories && c.status !== 'voided' && c.status !== 'merged' && (
            <button className="primaryish" onClick={() => setSub('addlines')}>
              加菜
            </button>
          )}
          <button onClick={() => setSub('history')}>查看历史</button>
        </div>

        {c.status === 'merged' ? (
          <p className="hint">这张单已并入其它单，明细已转移，不再计入营业额。</p>
        ) : c.status === 'voided' ? (
          <div className="actiongrid">
            {manage ? (
              <button
                className="restore"
                onClick={async () => {
                  await restoreTable(c.check_uuid)
                  await done()
                }}
              >
                恢复这一单
              </button>
            ) : (
              <p className="hint">已作废。恢复需要主管权限。</p>
            )}
          </div>
        ) : (
          <div className="actiongrid">
            {c.status === 'open' && (
              <>
                <button className="primaryish" onClick={() => setSub('pay')}>
                  结账
                </button>
                {/* 自提单没有桌位，换桌/并桌对它没有意义 */}
                {c.source === 'dine_in' && (
                  <button onClick={() => setSub('move')}>换桌 / 并桌</button>
                )}
              </>
            )}
            {c.status === 'closed' && (
              <button onClick={() => setSub('pay')}>改支付方式</button>
            )}
            {/* 已结账的单也能改和作废 —— 结完账才发现录错是常事 */}
            {manage && <button onClick={() => setSub('edit')}>改单</button>}
            {manage && (
              <button
                className="danger"
                onClick={() => {
                  setReason('')
                  setSub('void')
                }}
              >
                作废
              </button>
            )}
          </div>
        )}

        <div className="sheet-actions">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}


/**
 * 操作人显示。
 *
 * `by`（开台的人）在早期数据里可能缺失 —— 那时还没把操作人带进本地镜像。
 * 缺失时回退到 `last_by`，而不是显示成「— · 最近 张三」：
 * 一个破折号加一句"最近"，读起来像"没人开台但有人改过"，
 * 比直接显示那个人还难懂。
 */
export function operatorText(c: LocalCheck): string {
  const opened = c.by ?? c.last_by
  if (!opened) return '—'
  if (c.last_by && c.by && c.last_by !== c.by) return `${c.by} · 最近 ${c.last_by}`
  return opened
}
