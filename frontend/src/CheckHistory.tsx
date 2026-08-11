import { useEffect, useState } from 'react'
import { tr } from './i18n'
import { authFetch } from './auth'
import { money } from './catalog'
import { PAY_LABEL } from './CheckDetail'

interface HistoryOp {
  seq: number
  entity: string
  client_ts: string
  user_display: string | null
  payload: Record<string, any>
}

/** 重放到某一步时账单长什么样。改单是整体替换，所以必须重放才知道"改了什么"。 */
interface Snapshot {
  adult: number
  child: number
  senior: number
  drinkAdult: number
  drinkChild: number
  table: string
  status: string
}

const EMPTY: Snapshot = {
  adult: 0, child: 0, senior: 0, drinkAdult: 0, drinkChild: 0, table: '', status: '',
}

const FIELDS: { k: keyof Snapshot; label: string }[] = [
  { k: 'adult', label: '成人' },
  { k: 'child', label: '儿童' },
  { k: 'senior', label: '长者' },
  { k: 'drinkAdult', label: '成人饮料' },
  { k: 'drinkChild', label: '儿童饮料' },
]

function applyOp(s: Snapshot, op: HistoryOp): Snapshot {
  const p = op.payload
  const g = p.guests ?? {}
  const d = typeof p.drinks === 'number' ? { adult: p.drinks, child: 0 } : (p.drinks ?? {})

  switch (op.entity) {
    case 'open_check':
      return {
        adult: g.adult ?? 0, child: g.child ?? 0, senior: g.senior ?? 0,
        drinkAdult: d.adult ?? 0, drinkChild: d.child ?? 0,
        table: p.table_label ?? '', status: 'open',
      }
    case 'modify_check':
      return {
        ...s,
        adult: g.adult ?? 0, child: g.child ?? 0, senior: g.senior ?? 0,
        drinkAdult: d.adult ?? 0, drinkChild: d.child ?? 0,
      }
    case 'transfer_check':
      return { ...s, table: p.to_table_label ?? s.table }
    case 'close_check':
      return { ...s, status: 'closed' }
    case 'void_check':
      return { ...s, status: 'voided' }
    case 'restore_check':
      return { ...s, status: 'open' }
    default:
      return s
  }
}

/** 一条操作的人话描述 + 变化明细。 */
function describe(op: HistoryOp, before: Snapshot, after: Snapshot) {
  const p = op.payload
  const diffs: string[] = []

  switch (op.entity) {
    case 'open_check': {
      const parts: string[] = []
      if (after.adult) parts.push(`成人 ${after.adult}`)
      if (after.child) parts.push(`儿童 ${after.child}`)
      if (after.senior) parts.push(`长者 ${after.senior}`)
      if (after.drinkAdult) parts.push(`成人饮料 ${after.drinkAdult}`)
      if (after.drinkChild) parts.push(`儿童饮料 ${after.drinkChild}`)
      return { title: `开桌 ${after.table}`, diffs: parts, tone: 'ok' as const }
    }
    case 'modify_check': {
      for (const f of FIELDS) {
        const a = before[f.k] as number
        const b = after[f.k] as number
        if (a !== b) diffs.push(`${tr(f.label)} ${a} → ${b}`)
      }
      return {
        title: '改单',
        diffs: diffs.length ? diffs : ['（数量没有变化）'],
        tone: 'warn' as const,
      }
    }
    case 'transfer_check':
      return {
        title: '换桌',
        diffs: [`${before.table || '?'} → ${after.table}`],
        tone: 'warn' as const,
      }
    case 'merge_checks': {
      const n = (p.source_uuids ?? []).length
      const isTarget = p.check_uuid !== undefined && p.check_uuid !== null
      return {
        title: '并桌',
        diffs: [isTarget ? `并入了 ${n} 张单` : '本单被并入其它单'],
        tone: 'warn' as const,
      }
    }
    case 'close_check': {
      const pay = p.payment
      return {
        title: '结账',
        diffs: pay
          ? [
              `支付方式：${PAY_LABEL[pay.method] ?? pay.method}`,
              ...(pay.method === 'mixed'
                ? [`现金 ${money(pay.cash_cents ?? 0)} / 刷卡 ${money(pay.card_cents ?? 0)}`]
                : []),
              ...(pay.note ? [pay.note] : []),
            ]
          : ['未记录支付方式'],
        tone: 'ok' as const,
      }
    }
    case 'set_payment': {
      const pay = p.payment ?? {}
      return {
        title: '改支付方式',
        diffs: [
          `改为 ${PAY_LABEL[pay.method] ?? pay.method}`,
          ...(pay.note ? [pay.note] : []),
        ],
        tone: 'warn' as const,
      }
    }
    case 'void_check':
      return { title: '作废', diffs: [p.reason ?? ''], tone: 'bad' as const }
    case 'restore_check':
      return {
        title: '撤销作废',
        diffs: p.reason ? [p.reason] : ['恢复为作废前的状态'],
        tone: 'ok' as const,
      }
    default:
      return { title: op.entity, diffs: [], tone: 'warn' as const }
  }
}

export default function CheckHistory({
  checkUuid,
  tableLabel,
  onClose,
}: {
  checkUuid: string
  tableLabel: string
  onClose: () => void
}) {
  const [ops, setOps] = useState<HistoryOp[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    authFetch(`/api/checks/${checkUuid}/history`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setOps)
      // 历史来自服务端 —— 离线时看不了。说清楚，别装成"没有历史"
      .catch(() => setErr('需要联网才能查看历史'))
  }, [checkUuid])

  // 逐条重放，边放边算出每一步的前后差异
  const items: { op: HistoryOp; d: ReturnType<typeof describe> }[] = []
  let s = EMPTY
  for (const op of ops ?? []) {
    const after = applyOp(s, op)
    items.push({ op, d: describe(op, s, after) })
    s = after
  }

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <h2>{tableLabel} 操作历史</h2>

        {err && <p className="hint">{err}</p>}
        {!ops && !err && <p className="hint">{tr('载入中…')}</p>}
        {ops?.length === 0 && <p className="hint">{tr('还没有同步到服务器，暂无历史。')}</p>}

        <ol className="timeline">
          {items.map(({ op, d }) => (
            <li key={op.seq} className={d.tone}>
              <div className="t-head">
                <span className="t-title">{d.title}</span>
                <span className="grow" />
                <span className="dim small">{op.user_display ?? '—'}</span>
                <span className="dim small">
                  {new Date(op.client_ts).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </div>
              {d.diffs.filter(Boolean).map((x, i) => (
                <div key={i} className="t-diff">
                  {x}
                </div>
              ))}
            </li>
          ))}
        </ol>

        <p className="hint">{tr('历史来自服务端的操作日志，**每一条都记录了是谁、什么时候做的**， 不能删改。')}</p>

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('关闭')}</button>
        </div>
      </div>
    </div>
  )
}
