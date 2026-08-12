import { useEffect, useState } from 'react'
import { paren, tr } from './i18n'
import db, { type DeadLetter } from './db'

/**
 * The dead letter queue viewer.
 *
 * The header used to carry a red "Failed N" badge that did not open.
 * **Visible but not inspectable is the same as absent**: staff knew there were
 * N problems, not what they were or what to do. In a restaurant that means N
 * checks may be gone for good with nobody the wiser.
 */
export default function DeadLetters({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<DeadLetter[]>([])

  useEffect(() => {
    db.deadletter.orderBy('failed_at').reverse().toArray().then(setRows)
  }, [])

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Rejected operations')}{paren(String(rows.length))}</h2>
        <p className="hint">{tr('The server rejected these outright and will not retry. Read the reason, re-enter them by hand, then clear.')}</p>

        {rows.length === 0 && <p className="hint">{tr('No failures.')}</p>}

        <ul className="dl">
          {rows.map((d) => (
            <li key={d.op_id}>
              <div className="dl-top">
                <code className="tag warn">{d.entity}</code>
                <span className="dim small">
                  {new Date(d.failed_at).toLocaleString('zh-CN', { hour12: false })}
                </span>
              </div>
              <div className="dl-reason">{d.reason}</div>
              <code className="dl-payload">{JSON.stringify(d.payload)}</code>
            </li>
          ))}
        </ul>

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('Close')}</button>
          {rows.length > 0 && (
            <button
              className="danger"
              onClick={async () => {
                await db.deadletter.clear()
                setRows([])
              }}
            >{tr('Clear all')}</button>
          )}
        </div>
      </div>
    </div>
  )
}
