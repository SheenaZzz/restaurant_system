import { useCallback, useEffect, useState } from 'react'
import { lineName, modLabel, tr } from './i18n'
import { loadCatalog, type Catalog } from './catalog'
import db, { getMeta, setMeta, type LocalCheck, type LocalLine } from './db'

/**
 * The kitchen order queue. A la carte dishes from the front **appear here by themselves**.
 *
 * No new endpoint is involved: every device's local mirror already holds all
 * the checks and their lines (sync sends them), and the kitchen was only missing
 * a screen. So this page **still has tickets offline** -- the front keeps
 * entering, the kitchen keeps cooking, and both catch up afterwards.
 *
 * ⚠️ "Done" is **display state on this device, not a fact about the check**;
 *    it is stored locally and never synced. Why: sharing it would need a
 *    client-generated id per dish (local lines are rebuilt from the op payload
 *    and have no server line number), which is a whole change of its own --
 *    and DESIGN.md itself says to watch two weeks of real use first ("in a
 *    two-cook kitchen, a server walking five steps may well be faster").
 *    Ship the smallest thing; talk about shared state once it is being used.
 */

const DONE_KEY = 'kitchen_done'

interface Ticket {
  uuid: string
  table: string
  at: string
  lines: LocalLine[]
}

/** Dishes on a check that are not done yet. Voided ones do not count. */
function pending(c: LocalCheck, done: Set<string>): LocalLine[] {
  return (c.lines ?? []).filter(
    (l, i) => !l.voided && !done.has(`${c.check_uuid}#${i}`),
  )
}

/** Whether this check has anything for the kitchen (a pure buffet table does not enter the queue). */
function hasFood(c: LocalCheck): boolean {
  return (c.lines ?? []).some((l) => !l.voided)
}

export default function KitchenView() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())
  const [cat, setCat] = useState<Catalog | null>(null)
  const [, tick] = useState(0)

  const refresh = useCallback(async () => {
    const marks = new Set(await getMeta<string[]>(DONE_KEY, []))
    const rows = await db.checks.toArray()
    // A finished ticket **does not disappear**; it turns green and stays below --
    // a cook has to see what they just finished, and that is the only chance to
    // undo a mistap. What takes it off the screen is the front closing the check:
    // the guests paid and left, so it is over for the kitchen. That boundary is
    // truer than any timeout.
    const open = rows
      .filter((c) => c.status === 'open' && hasFood(c))
      .sort((a, b) => {
        const da = pending(a, marks).length === 0
        const db_ = pending(b, marks).length === 0
        // Unfinished first; within each group, oldest order first
        if (da !== db_) return da ? 1 : -1
        return a.opened_at.localeCompare(b.opened_at)
      })
    setDone(marks)
    setTickets(
      open.map((c) => ({
        uuid: c.check_uuid,
        table: c.table_label,
        at: c.opened_at,
        lines: c.lines ?? [],
      })),
    )
  }, [])

  useEffect(() => {
    void loadCatalog().then(setCat)
    void refresh()
    // Refreshed every 5 seconds: the sync heartbeat is at most 20, so ordering to
    // ticket is at most 25 seconds. The kitchen does not need faster, and should
    // not have it -- re-rendering every second makes whoever is reading lose their place.
    const t = window.setInterval(() => {
      tick((n) => n + 1)
      void refresh()
    }, 5_000)
    return () => window.clearInterval(t)
  }, [refresh])

  /** Mark and unmark. Tapping "done" by mistake is normal in a kitchen, so it has to be reversible. */
  async function mark(uuid: string, idx: number, undo = false) {
    const next = new Set(done)
    const key = `${uuid}#${idx}`
    if (undo) next.delete(key)
    else next.add(key)
    setDone(next)
    await setMeta(DONE_KEY, [...next])
    await refresh()
  }

  if (tickets === null) return <p className="hint">{tr('Loading…')}</p>

  if (!tickets.length) {
    return <p className="hint big-hint">{tr('No orders right now.')}</p>
  }

  const now = Date.now()

  return (
    <div className="kq">
      {tickets.map((t) => {
        const waited = Math.max(0, Math.round((now - Date.parse(t.at)) / 60_000))
        const live = t.lines.filter((l, i) => !l.voided && !done.has(`${t.uuid}#${i}`))
        const allDone = live.length === 0
        return (
          <section
            key={t.uuid}
            className={`kq-card${allDone ? ' ok' : waited >= 15 ? ' late' : ''}`}
          >
            <div className="kq-head">
              <span className="kq-table">{tr(t.table)}</span>
              {/* How long it has waited is far more use than when it was ordered -- a kitchen queues by order, not by clock */}
              <span className="kq-wait">{allDone ? tr('All done') : `${waited}′`}</span>
            </div>
            <ul className="kq-lines">
              {t.lines.map((l, i) => {
                const key = `${t.uuid}#${i}`
                if (l.voided) return null
                const isDone = done.has(key)
                return (
                  <li key={key} className={isDone ? 'done' : ''}>
                    <span className="kl-qty">{isDone ? '✓' : l.qty}</span>
                    <span className="kl-name">
                      {lineName(l, cat?.menu)}
                      {!!l.modifiers?.length && (
                        <em className="kl-mods">
                          {l.modifiers.map((m) => modLabel(m, cat?.modifiers)).join(' · ')}
                        </em>
                      )}
                      {l.notes && <em className="kl-mods">{l.notes}</em>}
                    </span>
                    <button
                      className={isDone ? 'kl-undo' : 'kl-done'}
                      onClick={() => void mark(t.uuid, i, isDone)}
                    >
                      {tr(isDone ? 'Undo' : 'Done')}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
