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

/** What the check looked like at one step. An edit replaces wholesale, so only a replay shows what changed. */
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
  { k: 'adult', label: 'Adult' },
  { k: 'child', label: 'Child' },
  { k: 'senior', label: 'Senior' },
  { k: 'drinkAdult', label: 'Adult drink' },
  { k: 'drinkChild', label: 'Child drink' },
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

/** One operation in plain words, plus what changed. */
function describe(op: HistoryOp, before: Snapshot, after: Snapshot) {
  const p = op.payload
  const diffs: string[] = []

  switch (op.entity) {
    case 'open_check': {
      const parts: string[] = []
      if (after.adult) parts.push(`${tr('Adult')} ${after.adult}`)
      if (after.child) parts.push(`${tr('Child')} ${after.child}`)
      if (after.senior) parts.push(`${tr('Senior')} ${after.senior}`)
      if (after.drinkAdult) parts.push(`${tr('Adult drink')} ${after.drinkAdult}`)
      if (after.drinkChild) parts.push(`${tr('Child drink')} ${after.drinkChild}`)
      return { title: `${tr('Seat table')} ${after.table}`, diffs: parts, tone: 'ok' as const }
    }
    case 'modify_check': {
      for (const f of FIELDS) {
        const a = before[f.k] as number
        const b = after[f.k] as number
        if (a !== b) diffs.push(`${tr(f.label)} ${a} → ${b}`)
      }
      return {
        title: tr('Edit check'),
        diffs: diffs.length ? diffs : [tr('(no change in the counts)')],
        tone: 'warn' as const,
      }
    }
    case 'transfer_check':
      return {
        title: tr('Transfer'),
        diffs: [`${before.table || '?'} → ${after.table}`],
        tone: 'warn' as const,
      }
    case 'merge_checks': {
      const n = (p.source_uuids ?? []).length
      const isTarget = p.check_uuid !== undefined && p.check_uuid !== null
      return {
        title: tr('Merge'),
        diffs: [isTarget ? `${tr('Folded in')} ${n}` : tr('This check was folded into another')],
        tone: 'warn' as const,
      }
    }
    case 'close_check': {
      const pay = p.payment
      return {
        title: tr('Collect'),
        diffs: pay
          ? [
              `${tr('Payment method')}: ${tr(PAY_LABEL[pay.method] ?? pay.method)}`,
              ...(pay.method === 'mixed'
                ? [`${tr('Cash')} ${money(pay.cash_cents ?? 0)} / ${tr('Card')} ${money(pay.card_cents ?? 0)}`]
                : []),
              ...(pay.note ? [pay.note] : []),
            ]
          : [tr('No payment method recorded')],
        tone: 'ok' as const,
      }
    }
    case 'set_payment': {
      const pay = p.payment ?? {}
      return {
        title: tr('Change payment method'),
        diffs: [
          `${tr('Changed to')} ${tr(PAY_LABEL[pay.method] ?? pay.method)}`,
          ...(pay.note ? [pay.note] : []),
        ],
        tone: 'warn' as const,
      }
    }
    case 'void_check':
      return { title: tr('Void'), diffs: [p.reason ?? ''], tone: 'bad' as const }
    case 'restore_check':
      return {
        title: tr('Undo void'),
        diffs: p.reason ? [p.reason] : [tr('Restored to the status before the void')],
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
      // The history comes from the server -- unavailable offline. Say so rather than pretending there is none
      .catch(() => setErr(tr('Needs a connection to load the history')))
  }, [checkUuid])

  // Replay one by one, computing each step's before and after as it goes
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
        <h2>{tableLabel} {tr('History')}</h2>

        {err && <p className="hint">{err}</p>}
        {!ops && !err && <p className="hint">{tr('Loading…')}</p>}
        {ops?.length === 0 && <p className="hint">{tr('Not synced yet, no history.')}</p>}

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

        <p className="hint">{tr('History comes from the server operation log — who did what and when. It cannot be edited.')}</p>

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('Close')}</button>
        </div>
      </div>
    </div>
  )
}
