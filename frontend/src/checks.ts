import {
  estimateCents,
  loadCatalog,
  partySize,
  serviceCents,
  taxCents,
  type Drinks,
  type MenuItem,
  type Modifier,
  type PickedModifier,
  type PriceRow,
} from './catalog'
import { getIdentity } from './auth'
import {
  businessDateOf,
  currentBusinessDate,
  shiftBusinessDate,
} from './businessDay'
import db, { setMeta, uuid, type LocalCheck, type LocalLine } from './db'
import { enqueue } from './sync'

export interface Guests {
  adult: number
  child: number
  senior: number
}

/**
 * Turn one order payload into a row in the local mirror.
 *
 * ⚠️ Add-on money has to be **folded into unit_price_cents**, exactly as the
 *    server's _add_lines does. The moment the two disagree, the amount on
 *    screen stops matching the amount stored -- and a check collected that way
 *    hangs in the month report's "payment does not match" list forever.
 *    (The tax rate on added dishes got this wrong once; see recalcEst.)
 *
 * Catalogue add-ons are estimated from **the locally cached price**; the server
 * recomputes from its own catalogue on write, so a stale cache only affects
 * what is displayed, never what is recorded.
 */
function buildLocalLine(
  l: any,
  menu: Map<number, MenuItem>,
  modifiers: Modifier[],
): LocalLine {
  const mi = menu.get(l.menu_item_id)
  const byId = new Map(modifiers.map((m) => [m.id, m]))

  const picked: {
    label: string
    label_en?: string
    modifier_id?: number
    price_cents: number
  }[] = (
    (l.modifiers ?? []) as PickedModifier[]
  ).map((p) => {
    if (p.modifier_id !== undefined) {
      const m = byId.get(p.modifier_id)
      // Not in the catalogue (the cache is too old): show 0 for now and let the
      // server decide. Never guess a price -- a wrong guess is the screen and the books disagreeing.
      return {
        label: m?.name_zh ?? `#${p.modifier_id}`,
        label_en: m?.name_en,
        modifier_id: p.modifier_id,
        price_cents: m?.price_cents ?? 0,
      }
    }
    return { label: p.label, price_cents: p.price_cents }
  })

  const base = mi?.open_price ? (l.amount_cents ?? 0) : (mi?.price_cents ?? 0)

  return {
    menu_item_id: l.menu_item_id,
    name: mi?.name_zh ?? mi?.name_en ?? `#${l.menu_item_id}`,
    name_en: mi?.name_en,
    qty: l.qty ?? 1,
    unit_price_cents: base + picked.reduce((a, m) => a + m.price_cents, 0),
    modifiers: picked.length ? picked : undefined,
    notes: l.notes,
  }
}

/**
 * Apply one op to the **local mirror**.
 *
 * Ops this device produced and ops pulled from other devices go through the
 * **same function** -- that is what event sourcing buys: local state is always
 * "every event replayed in order", so two code paths cannot drift apart.
 */
export async function applyCheckOp(
  entity: string,
  opId: string,
  payload: Record<string, unknown>,
  clientTs: string,
  opts: { synced: 0 | 1; remote: 0 | 1; who?: string },
): Promise<void> {
  if (entity === 'open_check') {
    const g = (payload.guests ?? {}) as Partial<Guests>
    const guests: Guests = {
      adult: g.adult ?? 0,
      child: g.child ?? 0,
      senior: g.senior ?? 0,
    }
    // Old shape: before the upgrade, drinks was a plain integer
    const rawD = payload.drinks
    const drinks: Drinks =
      typeof rawD === 'number'
        ? { adult: rawD, child: 0 }
        : {
            adult: (rawD as Partial<Drinks>)?.adult ?? 0,
            child: (rawD as Partial<Drinks>)?.child ?? 0,
          }
    const cat = await loadCatalog()
    const prices: PriceRow[] = cat?.prices ?? []
    const sub = estimateCents(prices, cat?.current_period_kind ?? 'dinner', guests, drinks)
    const svc = serviceCents(sub, partySize(guests, drinks))
    const tax = taxCents(sub, svc, cat?.tax_rate ?? 0)

    await db.checks.put({
      // A check's identity is the op_id of the op that created it --
      // an offline client cannot get a database key, so it mints its own
      check_uuid: opId,
      source: 'dine_in',
      lines: mapLines(payload.lines, await loadCatalog()),
      table_label: String(payload.table_label ?? '?'),
      status: 'open',
      opened_at: clientTs,
      ...guests,
      drink_adult: drinks.adult,
      drink_child: drinks.child,
      est_cents: sub + svc + tax,
      service_cents: svc,
      tax_cents: tax,
      by: opts.who,
      last_by: opts.who,
      ...opts,
    })
  } else if (entity === 'close_check') {
    const cu = String(payload.check_uuid ?? '')
    const row = await db.checks.get(cu)
    if (row) {
      await db.checks.put({
        ...row,
        status: 'closed',
        ...('payment' in payload ? payFields(payload.payment) : {}),
        last_by: opts.who ?? row.last_by,
      })
    }
  } else if (entity === 'modify_check') {
    const cu = String(payload.check_uuid ?? '')
    const row = await db.checks.get(cu)
    if (!row) return
    const g = (payload.guests ?? {}) as Partial<Guests>
    const guests: Guests = {
      adult: g.adult ?? 0,
      child: g.child ?? 0,
      senior: g.senior ?? 0,
    }
    const d = (payload.drinks ?? {}) as Partial<Drinks>
    const drinks: Drinks = { adult: d.adult ?? 0, child: d.child ?? 0 }
    const cat = await loadCatalog()
    const sub2 = estimateCents(
      cat?.prices ?? [], cat?.current_period_kind ?? 'dinner', guests, drinks,
    )
    const svc2 = serviceCents(sub2, partySize(guests, drinks))
    const tax2 = taxCents(sub2, svc2, cat?.tax_rate ?? 0)
    await db.checks.put({
      ...row,
      ...guests,
      drink_adult: drinks.adult,
      drink_child: drinks.child,
      est_cents: sub2 + svc2 + tax2,
      service_cents: svc2,
      tax_cents: tax2,
      last_by: opts.who ?? row.last_by,
      ...opts,
    })
  } else if (entity === 'void_check') {
    const cu = String(payload.check_uuid ?? '')
    const row = await db.checks.get(cu)
    if (row && row.status !== 'voided' && row.status !== 'merged') {
      await db.checks.put({
        ...row,
        // Remember the status before the void -- undo restores it, or a check
        // that went closed -> voided comes back as open and the table is occupied again
        pre_void_status: row.status,
        status: 'voided',
        void_reason: String(payload.reason ?? ''),
      })
    }
  } else if (entity === 'open_togo_check') {
    const cat = await loadCatalog()
    const menu = new Map((cat?.menu ?? []).map((m) => [m.id, m]))
    // Phone orders take add-ons too -- same builder, so the two paths cannot price differently
    const lines: LocalLine[] = ((payload.lines ?? []) as any[]).map((l) =>
      buildLocalLine(l, menu, cat?.modifiers ?? []),
    )
    await db.checks.put({
      check_uuid: opId,
      source: payload.source === 'buffet_togo' ? 'buffet_togo' : 'phone_order',
      table_label: payload.source === 'buffet_togo' ? 'Buffet to go' : 'Phone order',
      lines,
      customer_name: payload.customer_name as string | undefined,
      phone_last4: payload.phone_last4
        ? String(payload.phone_last4).slice(-4)
        : undefined,
      status: 'open',
      opened_at: clientTs,
      adult: 0, child: 0, senior: 0, drink_adult: 0, drink_child: 0,
      // A to-go check has no heads, so no large-party charge -- but it is still taxed
      service_cents: 0,
      tax_cents: taxCents(
        lines.reduce((a, l) => a + l.qty * l.unit_price_cents, 0),
        0,
        cat?.tax_rate ?? 0,
      ),
      est_cents:
        lines.reduce((a, l) => a + l.qty * l.unit_price_cents, 0) +
        taxCents(
          lines.reduce((a, l) => a + l.qty * l.unit_price_cents, 0),
          0,
          cat?.tax_rate ?? 0,
        ),
      by: opts.who,
      last_by: opts.who,
      ...opts,
    })
  } else if (entity === 'add_order_lines') {
    const row = await db.checks.get(String(payload.check_uuid ?? ''))
    if (row) {
      const cat = await loadCatalog()
      const menu = new Map((cat?.menu ?? []).map((m) => [m.id, m]))
      const add: LocalLine[] = ((payload.lines ?? []) as any[]).map((l) =>
        buildLocalLine(l, menu, cat?.modifiers ?? []),
      )
      const lines = [...(row.lines ?? []), ...add]
      await db.checks.put({
        ...row,
        lines,
        // Service charge and tax have to be written back together: updating only
        // est_cents leaves those two rows on the detail page stale, and the next
        // added dish derives from the stale values, so the error accumulates
        ...recalcEst(row, lines, cat?.tax_rate ?? 0),
        last_by: opts.who ?? row.last_by,
        ...opts,
      })
    }
  } else if (entity === 'transfer_check') {
    const row = await db.checks.get(String(payload.check_uuid ?? ''))
    if (row) {
      await db.checks.put({
        ...row,
        table_label: String(payload.to_table_label ?? row.table_label),
        last_by: opts.who ?? row.last_by,
        ...opts,
      })
    }
  } else if (entity === 'merge_checks') {
    const target = await db.checks.get(String(payload.check_uuid ?? ''))
    if (target) {
      let g = { adult: target.adult, child: target.child, senior: target.senior }
      let d = { adult: target.drink_adult, child: target.drink_child }
      for (const su of (payload.source_uuids ?? []) as string[]) {
        const src = await db.checks.get(su)
        if (!src || src.status === 'merged') continue
        g = {
          adult: g.adult + src.adult,
          child: g.child + src.child,
          senior: g.senior + src.senior,
        }
        d = { adult: d.adult + src.drink_adult, child: d.child + src.drink_child }
        await db.checks.put({
          ...src,
          status: 'merged',
          merged_into: target.check_uuid,
          adult: 0, child: 0, senior: 0,
          drink_adult: 0, drink_child: 0,
          est_cents: 0, service_cents: 0,
          last_by: opts.who ?? src.last_by,
        })
      }
      const cat = await loadCatalog()
      const sub = estimateCents(
        cat?.prices ?? [], cat?.current_period_kind ?? 'dinner', g, d,
      )
      // The party grew, so the service charge may go from 0 to something -- the consequence of merging people forget
      const svc = serviceCents(sub, partySize(g, d))
      const tax = taxCents(sub, svc, cat?.tax_rate ?? 0)
      await db.checks.put({
        ...target,
        tax_cents: tax,
        ...g,
        drink_adult: d.adult,
        drink_child: d.child,
        est_cents: sub + svc + tax,
        service_cents: svc,
        last_by: opts.who ?? target.last_by,
        ...opts,
      })
    }
  } else if (entity === 'set_payment') {
    const row = await db.checks.get(String(payload.check_uuid ?? ''))
    if (row) await db.checks.put({ ...row, ...payFields(payload.payment), ...opts })
  } else if (entity === 'add_payment') {
    // A top-up **adds**, it does not replace. It has to match the server's
    // add_payment exactly -- if the mirror's outstanding amount disagrees, staff collect the wrong number.
    const row = await db.checks.get(String(payload.check_uuid ?? ''))
    if (row) {
      const p = (payload.payment ?? {}) as Partial<Payment>
      const cash = (row.pay_cash ?? 0) + (p.cash_cents ?? 0)
      const card = (row.pay_card ?? 0) + (p.card_cents ?? 0)
      const other = (row.pay_other ?? 0) + (p.other_cents ?? 0)
      // The method is derived from the three buckets, not taken from the payload -- one card plus one cash is mixed
      const nonzero = [cash, card, other].filter((v) => v > 0).length
      const method: PayMethod | undefined =
        nonzero > 1 ? 'mixed' : cash > 0 ? 'cash' : card > 0 ? 'card' : other > 0 ? 'other' : undefined
      const note = p.note?.trim()
      await db.checks.put({
        ...row,
        pay_cash: cash,
        pay_card: card,
        pay_other: other,
        pay_method: method ?? row.pay_method,
        // The note **appends** rather than overwrites: the first one stays too
        pay_note: note ? (row.pay_note ? `${row.pay_note} / ${note}` : note) : row.pay_note,
        ...opts,
      })
    }
  } else if (entity === 'restore_check') {
    const cu = String(payload.check_uuid ?? '')
    const row = await db.checks.get(cu)
    if (row && row.status === 'voided') {
      await db.checks.put({
        ...row,
        status: row.pre_void_status ?? 'open',
        pre_void_status: undefined,
        void_reason: undefined,
      })
    }
  }
}

/** Undo a void and restore the previous status. The reason is optional. */
export async function restoreTable(checkUuid: string, reason?: string): Promise<void> {
  const payload = { check_uuid: checkUuid, reason: reason ?? '' }
  const opId = uuid()
  await enqueue('restore_check', payload, opId)
  await applyCheckOp('restore_check', opId, payload, new Date().toISOString(), {
    synced: 0,
    remote: 0,
    who: (await getIdentity())?.display_name,
  })
}

/** Edit a check: **replace** guests and drinks wholesale (never a delta), which is replay-safe. */
export async function modifyTable(
  checkUuid: string,
  guests: Guests,
  drinks: Drinks,
): Promise<void> {
  const payload = { check_uuid: checkUuid, guests, drinks }
  const opId = uuid()
  await enqueue('modify_check', payload, opId)
  await applyCheckOp('modify_check', opId, payload, new Date().toISOString(), {
    synced: 0,
    remote: 0,
    who: (await getIdentity())?.display_name,
  })
}

/** Void a whole check. **The reason is required** -- this is the only operation that makes a check's money disappear. */
export async function voidTable(checkUuid: string, reason: string): Promise<void> {
  const payload = { check_uuid: checkUuid, reason }
  const opId = uuid()
  await enqueue('void_check', payload, opId)
  await applyCheckOp('void_check', opId, payload, new Date().toISOString(), {
    synced: 0,
    remote: 0,
    who: (await getIdentity())?.display_name,
  })
}

/** Every check (closed and voided included), newest first. **Not scoped to a business day** -- only for the places that need to look across days. */
export async function allChecks(): Promise<LocalCheck[]> {
  const rows = await db.checks.toArray()
  return rows.sort((a, b) => b.opened_at.localeCompare(a.opened_at))
}

/** Which business day this check belongs to. */
export function checkBusinessDate(c: LocalCheck, cutoffHour: number): string {
  return businessDateOf(c.opened_at, cutoffHour)
}

/**
 * Every check on one business day, newest first.
 *
 * The check list and the day summary both have to use this rather than
 * allChecks() -- the header used to show today while the sales figure below was
 * everything since opening day. That combination is worse than no summary: it looks right.
 */
export async function checksOfDay(
  bdate: string,
  cutoffHour: number,
): Promise<LocalCheck[]> {
  const rows = await db.checks.toArray()
  return rows
    .filter((c) => checkBusinessDate(c, cutoffHour) === bdate)
    .sort((a, b) => b.opened_at.localeCompare(a.opened_at))
}

/**
 * Checks carried over -- not on the current business day, and not collected.
 *
 * ⚠️ These **must not simply vanish from the floor**. A table was opened, an
 *    amount is owed and nothing was collected, so that is money not yet
 *    received. A clean floor with nobody aware they exist is a silently lost
 *    check, and this system is the store's only record.
 *
 * To-go checks included: a phone order nobody collected and nobody voided is just as uncollected.
 */
export async function carriedOverChecks(
  bdate: string,
  cutoffHour: number,
): Promise<LocalCheck[]> {
  // ⚠️ A full scan on purpose, not where('status'). An index query **silently
  //    drops** records whose index key is invalid (that is how the NaN in the
  //    outbox happened) -- and the entire point of this function is that no
  //    open check may hide. A few hundred rows a day makes the scan free.
  const rows = await db.checks.toArray()
  return rows
    .filter((c) => c.status === 'open' && checkBusinessDate(c, cutoffHour) !== bdate)
    .sort((a, b) => a.opened_at.localeCompare(b.opened_at))
}

export interface Totals {
  revenueCents: number
  buffetGuests: number
  drinkCount: number
  openCount: number
  closedCount: number
  voidedCount: number
  voidedCents: number
  serviceCents: number
  cashCents: number
  cardCents: number
  otherCents: number
}

/**
 * Totals. **Voided checks are not sales**, but they are counted separately --
 * that number is exactly what the owner wants to see.
 */
export function totalsOf(rows: LocalCheck[]): Totals {
  const t: Totals = {
    revenueCents: 0, buffetGuests: 0, drinkCount: 0,
    openCount: 0, closedCount: 0, voidedCount: 0, voidedCents: 0,
    serviceCents: 0, cashCents: 0, cardCents: 0, otherCents: 0,
  }
  for (const c of rows) {
    // A merged check's lines have moved to its target, so it counts nowhere
    if (c.status === 'merged') continue
    if (c.status === 'voided') {
      t.voidedCount++
      t.voidedCents += c.est_cents
      continue
    }
    if (c.status === 'open') t.openCount++
    else t.closedCount++
    t.revenueCents += c.est_cents
    t.serviceCents += c.service_cents ?? 0
    t.buffetGuests += c.adult + c.child + c.senior
    t.drinkCount += c.drink_adult + c.drink_child
    t.cashCents += c.pay_cash ?? 0
    t.cardCents += c.pay_card ?? 0
    t.otherCents += c.pay_other ?? 0
  }
  return t
}

/** Open a table. Writes locally and queues, **without waiting for the network**. */
export async function openTable(
  tableLabel: string,
  guests: Guests,
  drinks: Drinks,
  /** Dishes ordered at open time -- the whole table skipping the buffet */
  lines: NewLine[] = [],
): Promise<string> {
  const payload = { table_label: tableLabel, guests, drinks, lines }
  // enqueue mints an op_id internally, but we need it as the check_uuid,
  // so it is generated here and passed in
  const opId = uuid()
  await enqueue('open_check', payload, opId)
  await applyCheckOp('open_check', opId, payload, new Date().toISOString(), {
    synced: 0,
    remote: 0,
    who: (await getIdentity())?.display_name,
  })
  return opId
}

export async function closeTable(checkUuid: string): Promise<void> {
  const payload = { check_uuid: checkUuid }
  const opId = uuid()
  await enqueue('close_check', payload, opId)
  await applyCheckOp('close_check', opId, payload, new Date().toISOString(), {
    synced: 0,
    remote: 0,
    who: (await getIdentity())?.display_name,
  })
}

/**
 * The floor: table label -> the open check on **the current business day**.
 *
 * Carried-over checks are not here -- the floor starts clean every day. They
 * are listed separately by carriedOverChecks(); see CarriedOver.tsx.
 */
export async function openChecksByTable(
  bdate: string,
  cutoffHour: number,
): Promise<Map<string, LocalCheck>> {
  const rows = await db.checks.toArray()
  const m = new Map<string, LocalCheck>()
  // ⚠️ Dine-in only. A to-go check has no table and would take up a cell.
  //    A missing `source` is data from before that field existed -- everything was dine-in then.
  for (const r of rows) {
    if (r.status !== 'open') continue
    if (!isDineIn(r)) continue
    if (checkBusinessDate(r, cutoffHour) !== bdate) continue
    m.set(r.table_label, r)
  }
  return m
}

/**
 * Table label -> a carried-over dine-in check. The floor checks this before opening a table.
 *
 * Why it has to: the server has a partial unique index, uq_check_open_per_table
 * (one open check per table). Yesterday's check still holds that table, so
 * opening a new one there today **is rejected by the server** and lands in the
 * dead letter queue. The table looks free, the tap does nothing -- which at
 * peak is exactly the kind of failure that makes people abandon a system.
 *
 * So it is caught here, with a message that says what to do about it. The
 * constraint guarantees correctness; the message makes it actionable -- same lesson as restore_check.
 */
export async function carriedOverByTable(
  bdate: string,
  cutoffHour: number,
): Promise<Map<string, LocalCheck>> {
  const rows = await carriedOverChecks(bdate, cutoffHour)
  const m = new Map<string, LocalCheck>()
  for (const r of rows) if (isDineIn(r)) m.set(r.table_label, r)
  return m
}

/** Old rows have no source field. Everything was dine-in then, so missing means dine-in. */
export function isDineIn(c: LocalCheck): boolean {
  return c.source === undefined || c.source === 'dine_in'
}

/** To-go is decided by **whitelist**, not by "not dine-in" -- the latter would sweep in old rows and any future kind. */
export function isTogo(c: LocalCheck): boolean {
  return c.source === 'buffet_togo' || c.source === 'phone_order'
}


export type PayMethod = 'cash' | 'card' | 'mixed' | 'other'

export interface Payment {
  method: PayMethod
  cash_cents: number
  card_cents: number
  other_cents: number
  note?: string
}

function payFields(raw: unknown) {
  const p = (raw ?? {}) as Partial<Payment>
  return {
    pay_method: p.method,
    pay_cash: p.cash_cents ?? 0,
    pay_card: p.card_cents ?? 0,
    pay_other: p.other_cents ?? 0,
    pay_note: p.note,
  }
}

/** Transfer to another table. Daily work, so regular staff can do it. */
export async function transferTable(checkUuid: string, toLabel: string): Promise<void> {
  const payload = { check_uuid: checkUuid, to_table_label: toLabel }
  const opId = uuid()
  await enqueue('transfer_check', payload, opId)
  await applyCheckOp('transfer_check', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
}

/** Merge: fold several checks into a target. **The result may trigger the large-party charge.** */
export async function mergeTables(
  targetUuid: string,
  sourceUuids: string[],
): Promise<void> {
  const payload = { check_uuid: targetUuid, source_uuids: sourceUuids }
  const opId = uuid()
  await enqueue('merge_checks', payload, opId)
  await applyCheckOp('merge_checks', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
}

/** Close the check and record how it was paid. */
export async function closeWithPayment(
  checkUuid: string,
  payment: Payment,
): Promise<void> {
  const payload = { check_uuid: checkUuid, payment }
  const opId = uuid()
  await enqueue('close_check', payload, opId)
  await applyCheckOp('close_check', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
}

/** Change the payment method afterwards. **Replaces wholesale** -- for "the method was recorded wrong". */
export async function updatePayment(
  checkUuid: string,
  payment: Payment,
): Promise<void> {
  const payload = { check_uuid: checkUuid, payment }
  const opId = uuid()
  await enqueue('set_payment', payload, opId)
  await applyCheckOp('set_payment', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
}

/**
 * Top up. **Adds to what was already collected** -- for "dishes were added after collecting".
 *
 * A different thing from updatePayment, and they must not be merged: replacing
 * would wipe the original $55.47 with the $6.99 top-up, making the "payment does not match" worse.
 */
export async function addPayment(
  checkUuid: string,
  payment: Payment,
): Promise<void> {
  const payload = { check_uuid: checkUuid, payment }
  const opId = uuid()
  await enqueue('add_payment', payload, opId)
  await applyCheckOp('add_payment', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
}

/** Total collected. */
export function paidCents(c: LocalCheck): number {
  return (c.pay_cash ?? 0) + (c.pay_card ?? 0) + (c.pay_other ?? 0)
}

/**
 * What is still outstanding (positive = still owed, negative = overpaid and owed back).
 *
 * Adding dishes after collecting produces a positive number; a voided dish a negative one.
 * The month report's "payment does not match the check" is exactly the checks where this is not 0.
 */
export function dueCents(c: LocalCheck): number {
  if (!c.pay_method) return 0 // nothing collected yet, so there is no gap to speak of
  return c.est_cents - paidCents(c)
}


/**
 * Which checks still have operations waiting to upload.
 *
 * ⚠️ **Derived from the outbox, never stored.**
 *
 * LocalCheck used to carry a `synced` field, marked by op_id after a
 * successful sync. That only holds for opening a check -- that op's id happens
 * to be the check's id. Collecting, editing and transferring use **new op
 * ids**, the marking never matches, and the check shows "pending" forever
 * although it uploaded long ago.
 *
 * A warning that never clears is not a warning: staff learn to ignore it after
 * twice and stop looking when it matters. So it is computed instead -- no op
 * in the outbox references it, therefore it is clean, and that cannot be wrong.
 */
export async function pendingCheckUuids(): Promise<Set<string>> {
  const ops = await db.outbox.toArray()
  const out = new Set<string>()
  for (const o of ops) {
    if (o.entity === 'open_check') {
      // Opening a check: the check's identity is this op's id
      out.add(o.op_id)
      continue
    }
    const cu = o.payload?.check_uuid
    if (typeof cu === 'string') out.add(cu)
    // A merge also affects the checks being folded in
    const srcs = o.payload?.source_uuids
    if (Array.isArray(srcs)) for (const x of srcs) if (typeof x === 'string') out.add(x)
  }
  return out
}

/** How many business days the local mirror keeps. Enough for "what happened on yesterday's check", without growing forever. */
export const LOCAL_KEEP_DAYS = 7

/**
 * Archiving: drop long-settled, uploaded checks from the **local mirror**.
 *
 * Only this device's cache; **the server keeps everything** -- the month report reads the server.
 *
 * Why: the mirror only ever grew, while the floor and the check list poll every
 * 2 seconds and scan the whole table to work out business days. Tens of
 * thousands of rows a year is visibly slow on an iPad. A local mirror exists so
 * the day's work survives a network outage; it is not an archive.
 *
 * All three have to hold; any one failing keeps the row:
 *   - closed / voided / merged -- an open check is kept forever, that is money not yet received
 *   - uploaded successfully   -- an unconfirmed one is never deleted; deleting it loses a check
 *   - older than the retention window
 */
export async function pruneLocalMirror(
  cutoffHour: number,
  keepDays: number = LOCAL_KEEP_DAYS,
): Promise<number> {
  const today = currentBusinessDate(cutoffHour)
  if (!today) return 0
  const oldest = shiftBusinessDate(today, -keepDays)
  const pending = await pendingCheckUuids()

  const rows = await db.checks.toArray()
  const doomed = rows
    .filter((c) => {
      if (c.status === 'open') return false
      // An op in the outbox still references it -- the replay has to find this check
      if (pending.has(c.check_uuid)) return false
      const bd = checkBusinessDate(c, cutoffHour)
      // Empty string = a broken timestamp. A check whose business day cannot be
      // computed is kept and stays visible; never deleted for being uncomputable.
      if (!bd) return false
      return bd < oldest
    })
    .map((c) => c.check_uuid)

  if (doomed.length) await db.checks.bulkDelete(doomed)
  return doomed.length
}


/**
 * Empty this device's check mirror and pull it again from the server.
 *
 * When it is needed: server data was cleared (a re-test, a data fix) while the
 * mirror still holds checks that no longer exist -- deleting on the server does
 * not notify a client, so the client has to start over.
 *
 * ⚠️ **Refuses to run while the outbox is not empty.** Those are real
 * operations that have not uploaded, and clearing them loses checks. Better to
 * make someone wait for a sync than to helpfully delete their work.
 *
 * Sign-in, the device id and the menu cache are kept -- what is reset is the
 * business data, not "which device this is".
 */
export async function resetLocalData(): Promise<{ ok: boolean; pending: number }> {
  const pending = await db.outbox.count()
  if (pending > 0) return { ok: false, pending }

  await db.transaction('rw', db.checks, db.events, db.deadletter, db.meta, async () => {
    await db.checks.clear()
    await db.events.clear()
    await db.deadletter.clear()
    // Cursor to zero -- the next sync pulls every change the server still has
    // and rebuilds the mirror from them. The direct payoff of event sourcing: no import step.
    await setMeta('cursor', 0)
    // ⚠️ Zeroing it is not enough. /api/sync normally **filters out ops this
    //    device produced** (so it does not re-apply its own writes), so pulling
    //    from 0 returns only other devices' checks and this iPad's own go missing. resync turns the filter off for one round.
    await setMeta('resync', 1)
  })
  return { ok: true, pending: 0 }
}


/**
 * Recompute the local amounts after a dish is added or voided.
 *
 * ⚠️ This had a bug that really did miscalculate money. Do not put it back:
 *
 * It used to be `taxRatio = tax_cents / est_cents` and then
 * `total = pre-tax x (1 + taxRatio)`. But `est_cents` **includes** tax, and tax
 * is charged on (subtotal + service charge), so that ratio is
 *   r / (1 + r)   rather than   r
 * A 7.1% rate was applied as 6.63%, losing a little tax on every added dish.
 *
 * The damage was not cosmetic: the server recomputes at the real rate when a
 * dish is added, so the "outstanding" on screen was slightly under the real
 * gap. Staff collected that, a tail was left on the books, and the month report kept flagging it.
 *
 * The comment at the time said "the tax rate is not available from the cached
 * catalog (this is a sync function)", which was false: the caller awaits
 * loadCatalog() right above. The rate is passed in now, and all four paths
 * (open / modify / merge / add) share one taxCents().
 *
 * All three numbers are written back together -- updating only est_cents
 * leaves the service charge and tax rows on the detail page stale, and the next
 * added dish derives head charges from those stale values, accumulating error.
 */
function recalcEst(
  row: LocalCheck,
  lines: LocalLine[],
  taxRate: number,
): { est_cents: number; service_cents: number; tax_cents: number } {
  // Head charges = old tax-inclusive total - old service charge - old tax - old dishes.
  // Derived rather than recomputed at current prices, to **keep the price
  // snapshot taken when the table opened** -- recomputing after a menu price change would restate the check.
  const head =
    row.est_cents -
    (row.service_cents ?? 0) -
    (row.tax_cents ?? 0) -
    (row.lines ?? [])
      .filter((l) => !l.voided)
      .reduce((a, l) => a + l.qty * l.unit_price_cents, 0)
  const lineSum = lines
    .filter((l) => !l.voided)
    .reduce((a, l) => a + l.qty * l.unit_price_cents, 0)
  const size = Math.max(
    row.adult + row.child + row.senior,
    row.drink_adult + row.drink_child,
  )
  const sub = head + lineSum
  const svc = serviceCents(sub, size)
  const tax = taxCents(sub, svc, taxRate)
  return { est_cents: sub + svc + tax, service_cents: svc, tax_cents: tax }
}

export interface NewLine {
  menu_item_id: number
  qty: number
  amount_cents?: number
  notes?: string
  /**
   * Add-ons / special requests. Catalogue ones send only modifier_id and
   * **no price** -- the server looks it up and ignores whatever the client sent.
   * Only a hand-typed request carries label + price_cents (that amount exists only at the counter, like open_price).
   */
  modifiers?: PickedModifier[]
}

/** Open a to-go check (Buffet To Go or a phone order). */
export async function openTogo(
  source: 'buffet_togo' | 'phone_order',
  lines: NewLine[],
  customer?: { name?: string; phone?: string },
): Promise<string> {
  const payload = {
    source,
    lines,
    customer_name: customer?.name,
    phone_last4: customer?.phone,
  }
  const opId = uuid()
  await enqueue('open_togo_check', payload, opId)
  await applyCheckOp('open_togo_check', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
  return opId
}

/** Add dishes to an existing check -- **dine-in included** (one guest on the buffet, another ordering). */
export async function addLines(checkUuid: string, lines: NewLine[]): Promise<void> {
  const payload = { check_uuid: checkUuid, lines }
  const opId = uuid()
  await enqueue('add_order_lines', payload, opId)
  await applyCheckOp('add_order_lines', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
}


/** Turn the dishes in a payload into local lines (filling in names and prices). */
function mapLines(raw: unknown, cat: Awaited<ReturnType<typeof loadCatalog>>): LocalLine[] {
  const menu = new Map((cat?.menu ?? []).map((m) => [m.id, m]))
  return ((raw ?? []) as any[]).map((l) => {
    const mi = menu.get(l.menu_item_id)
    return {
      menu_item_id: l.menu_item_id,
      name: mi?.name_zh ?? mi?.name_en ?? `#${l.menu_item_id}`,
      qty: l.qty ?? 1,
      unit_price_cents: mi?.open_price ? (l.amount_cents ?? 0) : (mi?.price_cents ?? 0),
      notes: l.notes,
    }
  })
}
