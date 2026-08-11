import { useCallback, useEffect, useState } from 'react'
import { tr } from './i18n'
import type { Role } from './auth'
import {
  businessDateLabel,
  clockDrift,
  currentBusinessDate,
  cutoffHourOf,
  offsetText,
} from './businessDay'
import { loadCatalog, money, type Catalog } from './catalog'
import {
  carriedOverChecks,
  checkBusinessDate,
  isTogo,
  pendingCheckUuids,
} from './checks'
import CheckDetail, { operatorText } from './CheckDetail'
import type { LocalCheck } from './db'

/**
 * 跨天未结账单。
 *
 * 楼面每天从干净的开始 —— 但**清空的只是楼面，不是账**。
 * 开了桌、有应收、没结账，就是钱还没收到；这套系统是店里唯一的
 * 主记录，从界面上消失就等于这笔钱再也没人会想起来。
 *
 * 所以横幅一直挂着直到处理完，而不是弹一次就算通知过了。
 */

function useCarried(): {
  rows: LocalCheck[]
  cat: Catalog | null
  today: string
  reload: () => Promise<void>
  pending: Set<string>
} {
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [cat, setCat] = useState<Catalog | null>(null)
  const [today, setToday] = useState('')
  const [pending, setPending] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    const c = await loadCatalog()
    const cutoff = cutoffHourOf(c)
    // 每次都重新算 —— 这台 iPad 可能整夜停在这一屏没重新加载过，
    // 过了零点要自己发现
    const bd = currentBusinessDate(cutoff)
    setCat(c)
    setToday(bd)
    setRows(await carriedOverChecks(bd, cutoff))
    setPending(await pendingCheckUuids())
  }, [])

  useEffect(() => {
    void reload()
    const t = window.setInterval(reload, 2000)
    return () => window.clearInterval(t)
  }, [reload])

  return { rows, cat, today, reload, pending }
}

/**
 * 设备时区和店里对不上的告警。
 *
 * 这台设备算营业日用的是**它自己的时钟**（离线时没有别的可用）。
 * 时区设错的话，每天靠近日界的那几个小时会把账单归到错误的营业日 ——
 * 静默地错，界面上一切正常。所以一旦偏了就一直挂着。
 */
export function ClockDriftBanner() {
  const [drift, setDrift] = useState<ReturnType<typeof clockDrift>>(null)

  useEffect(() => {
    const check = () => void loadCatalog().then((c) => setDrift(clockDrift(c)))
    check()
    // 10 秒一次。看着有点密，但读的是本地 IndexedDB，几乎不花钱。
    // 曾经设成 60 秒：冷启动那一下缓存里还是**上一版**的 catalog
    // （没有 store_utc_offset_minutes），于是判定为不偏；等 FloorPlan
    // 把 catalog 刷新回来之后，这里还要再等将近一分钟才发现 ——
    // 而这一分钟正好是员工刚打开 iPad、最可能开第一桌的时候。
    const t = window.setInterval(check, 10_000)
    return () => window.clearInterval(t)
  }, [])

  if (!drift) return null

  return (
    <div className="carry-banner bad" role="alert">
      <span className="cb-n">⚠</span>
      <span className="cb-txt">
        {tr('这台设备的时区和店里不一致')}
        <small>
          {tr('店里')} {offsetText(drift.storeMinutes)} · {tr('本机')}{' '}
          {offsetText(drift.deviceMinutes)}（{deviceTzName()}）
          <br />
          {tr('账单可能被算到错误的营业日。请到 iPad 的系统设置里把时区改成店里的。')}
        </small>
      </span>
    </div>
  )
}

function deviceTzName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return tr('未知')
  }
}

/** 横幅：没有跨天未结单时**什么都不渲染**，不占位、不干扰。 */
export function CarriedOverBanner({ role }: { role: Role }) {
  const [open, setOpen] = useState(false)
  const { rows, cat, reload, pending } = useCarried()

  if (rows.length === 0) return null

  const total = rows.reduce((s, c) => s + c.est_cents, 0)

  return (
    <>
      <button className="carry-banner" onClick={() => setOpen(true)}>
        <span className="cb-n">{rows.length}</span>
        <span className="cb-txt">
          {tr('张跨天未结账单')} · {money(total)}
          <small>{tr('楼面已翻到新的一天，这些还没结 —— 点开处理')}</small>
        </span>
        <span className="cb-go">›</span>
      </button>

      {open && (
        <CarriedOverSheet
          role={role}
          rows={rows}
          cat={cat}
          pending={pending}
          onChanged={reload}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function CarriedOverSheet({
  role,
  rows,
  cat,
  pending,
  onChanged,
  onClose,
}: {
  role: Role
  rows: LocalCheck[]
  cat: Catalog | null
  pending: Set<string>
  onChanged: () => void | Promise<void>
  onClose: () => void
}) {
  const [pick, setPick] = useState<LocalCheck | null>(null)
  const cutoff = cutoffHourOf(cat)

  // 详情开着时底下可能被别的设备结掉了 —— 跟着刷新，
  // 否则会拿着一张已经不存在的单去操作
  const live = pick
    ? (rows.find((r) => r.check_uuid === pick.check_uuid) ?? null)
    : null

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet wide" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('跨天未结账单')} {rows.length}</h2>
        <p className="hint">
          {tr('这些单开在今天之前还没结账。每一张都是开了桌但没收到的钱 —— 结掉或作废后才会从这里消失。')}
        </p>

        <div className="carry-list">
          {rows.map((c) => {
            const bd = checkBusinessDate(c, cutoff)
            return (
              <button
                key={c.check_uuid}
                className="carry-row"
                onClick={() => setPick(c)}
              >
                <span className="cr-day">{bd ? businessDateLabel(bd) : tr('时间异常')}</span>
                <span className="cr-table">
                  {isTogo(c) ? (c.customer_name || tr('自提')) : c.table_label}
                </span>
                <span className="cr-money">{money(c.est_cents)}</span>
                <span className="cr-who">{operatorText(c)}</span>
                {pending.has(c.check_uuid) && <span className="tag warn">{tr('未上传')}</span>}
                <span className="cb-go">›</span>
              </button>
            )
          })}
        </div>

        <p className="hint">
          {tr('⚠️ 同一张桌今天开不了新单 —— 一张桌同时只能有一张未结账单。先把这里处理完。')}
        </p>

        <div className="sheet-actions">
          <button onClick={onClose}>{tr('知道了')}</button>
        </div>
      </div>

      {live && cat && (
        <CheckDetail
          check={live}
          role={role}
          prices={cat.prices}
          period={cat.current_period_kind}
          openChecks={rows}
          menu={cat.menu}
          categories={cat.categories}
          modifiers={cat.modifiers ?? []}
          pending={pending.has(live.check_uuid)}
          onClose={() => setPick(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}
