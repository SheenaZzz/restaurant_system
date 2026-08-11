import { useCallback, useEffect, useState } from 'react'
import { getLang, locale, tr, paren } from './i18n'
import { canManage, type Role } from './auth'
import {
  loadCatalog,
  money,
  type Category,
  type MenuItem,
  type Modifier,
  type PriceRow,
} from './catalog'
import {
  businessDateLabel,
  currentBusinessDate,
  cutoffHourOf,
} from './businessDay'
import { checksOfDay, dueCents, pendingCheckUuids, totalsOf } from './checks'
import CheckDetail, { operatorText, PAY_LABEL, STATUS_LABEL } from './CheckDetail'
import type { LocalCheck } from './db'

type Filter = 'all' | 'open' | 'due' | 'closed' | 'voided'

const FILTERS: { k: Filter; label: string }[] = [
  { k: 'all', label: '全部' },
  { k: 'open', label: '未结' },
  // 「未收清」不是一个状态，是一个**条件** —— 单子已经关了，
  // 但钱没收齐。放在未结旁边，因为它俩是同一类待办：还有钱没到手。
  { k: 'due', label: '未收清' },
  { k: 'closed', label: '已结' },
  { k: 'voided', label: '已作废' },
]

/** 这张单是否属于某个过滤条件。 */
function matches(c: LocalCheck, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'due') return dueCents(c) !== 0
  return c.status === f
}

export default function ListView({ role }: { role: Role }) {
  const [rows, setRows] = useState<LocalCheck[]>([])
  const [prices, setPrices] = useState<PriceRow[]>([])
  const [menu, setMenu] = useState<MenuItem[]>([])
  const [cats, setCats] = useState<Category[]>([])
  const [mods, setMods] = useState<Modifier[]>([])
  const [period, setPeriod] = useState<'lunch' | 'dinner'>('dinner')
  const [now, setNow] = useState(new Date())
  const [bdate, setBdate] = useState('')
  const [pick, setPick] = useState<LocalCheck | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [pending, setPending] = useState<Set<string>>(new Set())

  const reload = useCallback(async () => {
    // ⚠️ 只取**当前营业日**的单。原来这里是 allChecks() ——
    //    头部时钟显示今天，下面的「营业额」却是开业至今的累计。
    //    那个组合比没有汇总更危险：它看起来完全正常。
    const c = await loadCatalog()
    const cutoff = cutoffHourOf(c)
    // 每次重算，不缓存 —— 页面可能整夜没重新加载过
    const today = currentBusinessDate(cutoff)
    setBdate(today)
    const all = await checksOfDay(today, cutoff)
    setRows(all)
    setPending(await pendingCheckUuids())
    // 详情开着时底下可能被别的设备改了 —— 跟着刷新，
    // 否则会拿着过期的金额去结账
    setPick((p) => (p ? (all.find((r) => r.check_uuid === p.check_uuid) ?? null) : null))
  }, [])

  useEffect(() => {
    void reload()
    loadCatalog().then((c) => {
      if (c) {
        setPrices(c.prices)
        setMenu(c.menu)
        setCats(c.categories)
        setMods(c.modifiers ?? [])
        setPeriod(c.current_period_kind)
      }
    })
    // 时钟走 iPad 本地时间 —— 员工核对时看的是墙上的钟，不是服务器时间
    const clock = window.setInterval(() => setNow(new Date()), 1000)
    const poll = window.setInterval(reload, 2000)
    return () => {
      window.clearInterval(clock)
      window.clearInterval(poll)
    }
  }, [reload])

  const t = totalsOf(rows)
  const manage = canManage(role)
  const shown = rows.filter((r) => matches(r, filter))
  const openChecks = rows.filter((r) => r.status === 'open')
  // 已关单但钱没收齐的 —— 这笔钱在楼面上已经看不见了（桌子空了），
  // 清单页是唯一还能发现它的地方
  const dueRows = rows.filter((r) => dueCents(r) > 0)
  const dueTotal = dueRows.reduce((s, r) => s + dueCents(r), 0)

  return (
    <>
      <div className="list-head">
        <div className="clock">
          <span className="time">
            {now.toLocaleTimeString(locale(), { hour12: false })}
          </span>
          {/* 显示的是**营业日**，不是设备日期。日界不是 0 点时
              两者会差一段，而下面所有数字都是按营业日算的 */}
          <span className="date">{bdate ? businessDateLabel(bdate) : '—'}</span>
        </div>

        <div className="stats">
          <Stat label={tr('营业额')} value={money(t.revenueCents)} big />
          <Stat label={tr('Buffet 人数')} value={String(t.buffetGuests)} />
          <Stat label={tr('饮料份数')} value={String(t.drinkCount)} />
          <Stat label={tr('未结 / 已结')} value={`${t.openCount} / ${t.closedCount}`} />
          {/* 「已结但没收齐」必须能一眼看到，不能只在卡片里。
              一天几十单，靠扫卡片找是找不出来的 */}
          {dueRows.length > 0 && (
            <Stat
              label={tr('待收')}
              value={`${dueRows.length} · ${money(dueTotal)}`}
              bad
            />
          )}
          {t.serviceCents > 0 && (
            <Stat label={tr('大桌服务费')} value={money(t.serviceCents)} />
          )}
          <Stat
            label={tr('现金 / 刷卡 / 其它')}
            value={`${money(t.cashCents)} · ${money(t.cardCents)} · ${money(t.otherCents)}`}
          />
          {t.voidedCount > 0 && (
            <Stat
              label={tr('已作废')}
              value={`${t.voidedCount} · ${money(t.voidedCents)}`}
              bad
            />
          )}
        </div>
      </div>

      <div className="tabs sub">
        {FILTERS.map((f) => (
          <button
            key={f.k}
            className={filter === f.k ? 'on' : ''}
            onClick={() => setFilter(f.k)}
          >
            {tr(f.label)}
            <span className="cnt">{rows.filter((r) => matches(r, f.k)).length}</span>
          </button>
        ))}
      </div>

      {!manage && <p className="hint">{tr('你的账号无改单、作废权限。')}</p>}

      {shown.length === 0 && <p className="hint">{tr('没有符合条件的账单。')}</p>}

      <div className="cards">
        {shown.map((c) => {
          const guests = c.adult + c.child + c.senior
          const drinks = c.drink_adult + c.drink_child
          const due = dueCents(c)
          return (
            <button
              key={c.check_uuid}
              // 关了单但钱没收齐的，**不能长得和收齐的一样**。
              // 绿色「已结」是这套界面里最强的"这单完事了"信号，
              // 用它盖住一笔没收到的钱，等于把钱藏起来。
              className={`card ${c.status}${due !== 0 ? ' due' : ''}`}
              onClick={() => setPick(c)}
            >
              <div className="c-top">
                <span className="c-table">{tr(c.table_label)}</span>
                <span
                  className={`tag ${c.status === 'open' ? 'warn' : c.status === 'voided' ? 'bad' : 'ok'}`}
                >
                  {tr(STATUS_LABEL[c.status])}
                </span>
                {/* 状态和收款是两件事：单确实已经关了（桌子空出来了），
                    但钱还没到齐。所以两个标签并存，不是互相替换。 */}
                {due > 0 && <span className="tag warn">{tr('待收')} {money(due)}</span>}
                {due < 0 && <span className="tag bad">{tr('多收')} {money(-due)}</span>}
                {pending.has(c.check_uuid) && (
                  <span className="tag warn">{tr('未上传')}</span>
                )}
                <span className="grow" />
                <span className="c-time">
                  {new Date(c.opened_at).toLocaleTimeString(locale(), {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              <div className="c-money">
                {money(c.est_cents)}
                {c.service_cents > 0 && (
                  <span className="c-svc">{tr('含服务费')} {money(c.service_cents)}</span>
                )}
              </div>

              <div className="c-line">
                {guests > 0 && <span className="chip">{guestText(c)}</span>}
                {drinks > 0 && <span className="chip">{drinkText(c)}</span>}
              </div>

              <div className="c-foot">
                <span>{c.pay_method ? tr(PAY_LABEL[c.pay_method]) : tr('未记支付')}</span>
                <span className="grow" />
                <span>{operatorText(c)}</span>
              </div>

              {c.void_reason && <div className="c-note">{c.void_reason}</div>}
              {c.merged_into && <div className="c-note">{tr('已并入其它单')}</div>}
            </button>
          )
        })}
      </div>

      {pick && (
        <CheckDetail
          check={pick}
          role={role}
          prices={prices}
          period={period}
          openChecks={openChecks}
          menu={menu}
          categories={cats}
          modifiers={mods}
          pending={pending.has(pick.check_uuid)}
          onClose={() => setPick(null)}
          onChanged={reload}
        />
      )}
    </>
  )
}

/**
 * 「3人（成2童1）」而不是「3人 · 成2 · 童1」——
 * 后者容易被读成三个并列的数字，加起来变成 6 个人。
 * 只有一种客型时不显示括号，省得每张卡都写「2人（成2）」这种废话。
 */
function guestText(c: LocalCheck): string {
  const total = c.adult + c.child + c.senior
  // 中文「3人（成2童1）」；英文语序不同，拆成 "3 guests (2A 1C)"
  const zh = getLang() === 'zh'
  const parts: string[] = []
  if (c.adult) parts.push(zh ? `成${c.adult}` : `${c.adult}A`)
  if (c.child) parts.push(zh ? `童${c.child}` : `${c.child}C`)
  if (c.senior) parts.push(zh ? `长${c.senior}` : `${c.senior}S`)
  const head = zh ? `${total}人` : `${total} ${tr('位')}`
  return parts.length > 1 ? `${head}${paren(parts.join(zh ? '' : ' '))}` : head
}

function drinkText(c: LocalCheck): string {
  const total = c.drink_adult + c.drink_child
  return c.drink_adult && c.drink_child
    ? `${tr('饮')}${total}${paren(`${c.drink_adult}/${c.drink_child}`)}`
    : `${tr('饮')}${total}`
}

function Stat({
  label,
  value,
  big,
  bad,
}: {
  label: string
  value: string
  big?: boolean
  bad?: boolean
}) {
  return (
    <div className={`stat${big ? ' big' : ''}${bad ? ' bad' : ''}`}>
      <span className="sv">{value}</span>
      <span className="sl">{label}</span>
    </div>
  )
}
