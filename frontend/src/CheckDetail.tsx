import { useState } from 'react'
import { modLabel, lineName, locale, tr, paren } from './i18n'
import { canManage, type Role } from './auth'
import {
  money,
  type Category,
  type Drinks,
  type MenuItem,
  type Modifier,
  type PriceRow,
} from './catalog'
import {
  addLines,
  addPayment,
  closeWithPayment,
  dueCents,
  mergeTables,
  modifyTable,
  paidCents,
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
  modifiers = [],
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
  /** 加料目录，传给加菜里的点菜页 */
  modifiers?: Modifier[]
  /** 这张单还有操作没上传到服务端 */
  pending?: boolean
  onClose: () => void
  onChanged: () => void | Promise<void>
}) {
  const [sub, setSub] = useState<
    'pay' | 'topup' | 'move' | 'edit' | 'void' | 'history' | 'addlines' | null
  >(null)
  const [reason, setReason] = useState('')
  const manage = canManage(role)
  const c = check
  // 结完账又加菜 → due > 0（还欠）；退了菜 → due < 0（多收了）。
  // 月报里「支付与账单不符」抓的就是这个数不为 0 的单。
  const paid = paidCents(c)
  const due = dueCents(c)

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

  // 补收差额：只录**还没收的那部分**，走 addPayment（累加）
  // 而不是 updatePayment（替换）—— 替换会把之前收的那笔冲掉。
  if (sub === 'topup') {
    return (
      <PaymentSheet
        check={c}
        title={tr('补收差额')}
        amount={due}
        collected={paid}
        onCancel={() => setSub(null)}
        onConfirm={async (p: Payment) => {
          await addPayment(c.check_uuid, p)
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
        modifiers={modifiers}
        title={`${tr(c.table_label)} · ${tr('加菜')}`}
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
        tableLabel={tr(c.table_label)}
        onClose={() => setSub(null)}
      />
    )
  }

  if (sub === 'void') {
    return (
      <div className="sheet-back" onClick={() => setSub(null)}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <h2>作废 {tr(c.table_label)}</h2>
          <p className="total">{money(c.est_cents)}</p>
          <p className="hint">
            作废会把这单从营业额里剔除，必须填写原因，会记录操作人。
            作废后可以随时「恢复」。
            {c.status === 'closed' && ' 恢复后仍是已结账状态，结账时间不变。'}
          </p>
          <label className="reason">
            {tr('原因')}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={tr('例如：客人取消 / 录错桌号')}
              autoFocus
            />
          </label>
          <div className="sheet-actions">
            <button onClick={() => setSub(null)}>{tr('取消')}</button>
            <button
              className="primary danger"
              disabled={!reason.trim()}
              onClick={async () => {
                await voidTable(c.check_uuid, reason.trim())
                await done()
              }}
            >{tr('确认作废')}</button>
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
          {tr(c.table_label)}
          <span className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}>
            {tr(STATUS_LABEL[c.status])}
          </span>
          {pending && <span className="tag warn">{tr('未上传')}</span>}
        </h2>

        <table className="kv">
          <tbody>
            <tr>
              <td className="dim">{tr('开台')}</td>
              <td className="num">
                {new Date(c.opened_at).toLocaleString(locale(), { hour12: false })}
              </td>
            </tr>
            <tr>
              <td className="dim">{tr('Buffet 人数')}</td>
              <td className="num">
                {guests
                  ? `${guests}${paren(`${tr('成人')} ${c.adult} · ${tr('儿童')} ${c.child} · ${tr('长者')} ${c.senior}`)}`
                  : '—'}
              </td>
            </tr>
            <tr>
              <td className="dim">{tr('饮料')}</td>
              <td className="num">
                {drinks
                  ? `${drinks}${paren(`${tr('成人')} ${c.drink_adult} · ${tr('儿童')} ${c.drink_child}`)}`
                  : '—'}
              </td>
            </tr>
            {c.service_cents > 0 && (
              <tr>
                <td className="dim">{tr('大桌服务费 10%')}</td>
                <td className="num">{money(c.service_cents)}</td>
              </tr>
            )}
            {(c.tax_cents ?? 0) > 0 && (
              <tr>
                <td className="dim">{tr('税')}</td>
                <td className="num">{money(c.tax_cents)}</td>
              </tr>
            )}
            <tr>
              <td className="dim">{tr('支付方式')}</td>
              <td className="num">
                {c.pay_method ? tr(PAY_LABEL[c.pay_method]) : tr('未记录')}
                {c.pay_method === 'mixed' &&
                  paren(`${tr('现金')} ${money(c.pay_cash ?? 0)} / ${tr('刷卡')} ${money(c.pay_card ?? 0)}`)}
                {c.pay_note && ` · ${c.pay_note}`}
              </td>
            </tr>
            {/* 差额单独一行，且只在不为 0 时出现。
                这是月报「支付与账单不符」在单张单上的样子 ——
                在报表里看到一个计数，却不知道是哪一单差多少，等于没告诉你。 */}
            {due !== 0 && (
              <tr>
                <td className="dim">{tr(due > 0 ? '待收' : '多收（应退）')}</td>
                <td className={`num ${due > 0 ? 'warnText' : 'badText'}`}>
                  {money(Math.abs(due))}
                  <span className="dim"> · {tr('已收')} {money(paid)}</span>
                </td>
              </tr>
            )}
            {(c.customer_name || c.phone_last4) && (
              <tr>
                <td className="dim">{tr('客人')}</td>
                <td className="num">
                  {c.customer_name ?? '—'}
                  {c.phone_last4 && ` · ${tr('尾号')} ${c.phone_last4}`}
                </td>
              </tr>
            )}
            <tr>
              <td className="dim">{tr('操作人')}</td>
              <td className="num">{operatorText(c)}</td>
            </tr>
            {c.void_reason && (
              <tr>
                <td className="dim">{tr('作废原因')}</td>
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
                      {lineName(l, menu)}
                      {l.qty > 1 && <span className="dim"> ×{l.qty}</span>}
                      {/* 加了什么必须列出来 —— 后厨要照着做，
                          客人问"我加的虾收了钱吗"也得答得上来。
                          金额已经折进单价了，这里只是拆给人看。 */}
                      {(l.modifiers ?? []).length > 0 && (
                        <div className="line-mods">
                          {l.modifiers!.map((m, j) => (
                            <span key={j} className="chip sm">
                              {modLabel(m, modifiers)}
                              {m.price_cents > 0 && ` +${money(m.price_cents)}`}
                            </span>
                          ))}
                        </div>
                      )}
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

        {/* 退款方向不自动做。系统不碰钱，"实际退了多少"只有经手的人知道；
            这里把差在哪说清楚，退钱和改数由人决定，别替他们写一笔。 */}
        {due < 0 && (
          <p className="hint warnbox">
            {tr('已收')} {money(paid)}, {tr('比账单多')} {money(-due)} —
            {' '}{tr('多半是结账后退了菜或改小了人数。请把多收的退给客人，再用「改支付方式」把金额改成实收。')}</p>
        )}

        {pending && (
          <p className="hint">
            这张单还有改动<b>{tr('只存在这台 iPad 上')}</b>{tr('，没传到服务器。 联网后会自动补发，不用做任何操作。')}</p>
        )}

        <div className="actiongrid">
          {menu && categories && c.status !== 'voided' && c.status !== 'merged' && (
            <button className="primaryish" onClick={() => setSub('addlines')}>{tr('加菜')}</button>
          )}
          <button onClick={() => setSub('history')}>{tr('查看历史')}</button>
        </div>

        {c.status === 'merged' ? (
          <p className="hint">{tr('这张单已并入其它单，明细已转移，不再计入营业额。')}</p>
        ) : c.status === 'voided' ? (
          <div className="actiongrid">
            {manage ? (
              <button
                className="restore"
                onClick={async () => {
                  await restoreTable(c.check_uuid)
                  await done()
                }}
              >{tr('恢复这一单')}</button>
            ) : (
              <p className="hint">{tr('已作废。恢复需要主管权限。')}</p>
            )}
          </div>
        ) : (
          <div className="actiongrid">
            {c.status === 'open' && (
              <>
                <button className="primaryish" onClick={() => setSub('pay')}>{tr('结账')}</button>
                {/* 自提单没有桌位，换桌/并桌对它没有意义 */}
                {c.source === 'dine_in' && (
                  <button onClick={() => setSub('move')}>{tr('换桌 / 并桌')}</button>
                )}
              </>
            )}
            {c.status === 'closed' && (
              <>
                {/* 结完账又加了菜 —— 差额要能当场补收，而且是**主操作**。
                    藏在「改支付方式」后面的话，员工只会把整单金额重录一遍，
                    结果不是漏收就是把之前那笔冲掉。 */}
                {due > 0 && (
                  <button className="primaryish" onClick={() => setSub('topup')}>
                    {tr('补收')} {money(due)}
                  </button>
                )}
                <button onClick={() => setSub('pay')}>{tr('改支付方式')}</button>
              </>
            )}
            {/* 已结账的单也能改和作废 —— 结完账才发现录错是常事 */}
            {manage && <button onClick={() => setSub('edit')}>{tr('改单')}</button>}
            {manage && (
              <button
                className="danger"
                onClick={() => {
                  setReason('')
                  setSub('void')
                }}
              >{tr('作废')}</button>
            )}
          </div>
        )}

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('关闭')}</button>
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
  // tr() 查不到就原样返回 —— 种子账号叫「前台主管」会被翻掉，
  // 真人姓名（张三）不在词表里，原样保留。这正是回退的用处。
  if (c.last_by && c.by && c.last_by !== c.by)
    return `${tr(c.by)} · ${tr('最近')} ${tr(c.last_by)}`
  return tr(opened)
}
