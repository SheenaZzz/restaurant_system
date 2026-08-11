import { useEffect, useState } from 'react'
import { tr } from './i18n'
import db, { type DeadLetter } from './db'

/**
 * 死信队列查看器。
 *
 * 之前头部只有一个红色「失败 N」徽章、点不开 —— **看得见但查不了，
 * 等于没有**。员工只知道"出了 N 个问题"，不知道是什么、也没法处理。
 * 在餐馆里这意味着 N 单可能永远丢了而没人知道。
 */
export default function DeadLetters({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<DeadLetter[]>([])

  useEffect(() => {
    db.deadletter.orderBy('failed_at').reverse().toArray().then(setRows)
  }, [])

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <h2>被拒绝的操作（{rows.length}）</h2>
        <p className="hint">{tr('这些操作服务端明确拒绝了，不会自动重试。看清原因后手动重新录入即可， 确认无误后再清除。')}</p>

        {rows.length === 0 && <p className="hint">{tr('没有失败记录。')}</p>}

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
          <button onClick={onClose}>{tr('关闭')}</button>
          {rows.length > 0 && (
            <button
              className="danger"
              onClick={async () => {
                await db.deadletter.clear()
                setRows([])
              }}
            >{tr('全部清除')}</button>
          )}
        </div>
      </div>
    </div>
  )
}
