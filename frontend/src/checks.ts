import { estimateCents, loadCatalog, type Drinks, type PriceRow } from './catalog'
import db, { uuid, type LocalCheck } from './db'
import { enqueue } from './sync'

export interface Guests {
  adult: number
  child: number
  senior: number
}

/**
 * 把一条 open_check / close_check 应用到**本地镜像**。
 *
 * 自己产生的 op 和从 changes 拉到的别人的 op 走**同一个函数** ——
 * 这是事件溯源的好处：本地状态永远是"把所有事件按顺序放一遍"的结果，
 * 不存在两套逻辑漂移的可能。
 */
export async function applyCheckOp(
  entity: string,
  opId: string,
  payload: Record<string, unknown>,
  clientTs: string,
  opts: { synced: 0 | 1; remote: 0 | 1 },
): Promise<void> {
  if (entity === 'open_check') {
    const g = (payload.guests ?? {}) as Partial<Guests>
    const guests: Guests = {
      adult: g.adult ?? 0,
      child: g.child ?? 0,
      senior: g.senior ?? 0,
    }
    // 兼容旧格式：升级前排队的 op 里 drinks 是个整数
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

    await db.checks.put({
      // 账单的身份就是创建它那条 op 的 op_id ——
      // 客户端离线时拿不到数据库主键，只能自己生成标识
      check_uuid: opId,
      table_label: String(payload.table_label ?? '?'),
      status: 'open',
      opened_at: clientTs,
      ...guests,
      drink_adult: drinks.adult,
      drink_child: drinks.child,
      est_cents: estimateCents(
        prices,
        cat?.current_period_kind ?? 'dinner',
        guests,
        drinks,
      ),
      ...opts,
    })
  } else if (entity === 'close_check') {
    const cu = String(payload.check_uuid ?? '')
    const row = await db.checks.get(cu)
    if (row) await db.checks.put({ ...row, status: 'closed' })
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
    await db.checks.put({
      ...row,
      ...guests,
      drink_adult: drinks.adult,
      drink_child: drinks.child,
      est_cents: estimateCents(
        cat?.prices ?? [],
        cat?.current_period_kind ?? 'dinner',
        guests,
        drinks,
      ),
      ...opts,
    })
  } else if (entity === 'void_check') {
    const cu = String(payload.check_uuid ?? '')
    const row = await db.checks.get(cu)
    if (row) {
      await db.checks.put({
        ...row,
        status: 'voided',
        void_reason: String(payload.reason ?? ''),
      })
    }
  }
}

/** 改单：**整体替换**人数与饮料（不是增量），重放安全。 */
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
  })
}

/** 作废整张单。**原因必填** —— 这是唯一能让一整张单的钱消失的操作。 */
export async function voidTable(checkUuid: string, reason: string): Promise<void> {
  const payload = { check_uuid: checkUuid, reason }
  const opId = uuid()
  await enqueue('void_check', payload, opId)
  await applyCheckOp('void_check', opId, payload, new Date().toISOString(), {
    synced: 0,
    remote: 0,
  })
}

/** 全部账单（含已结、已作废），按开台时间倒序。 */
export async function allChecks(): Promise<LocalCheck[]> {
  const rows = await db.checks.toArray()
  return rows.sort((a, b) => b.opened_at.localeCompare(a.opened_at))
}

export interface Totals {
  revenueCents: number
  buffetGuests: number
  drinkCount: number
  openCount: number
  closedCount: number
  voidedCount: number
  voidedCents: number
}

/**
 * 汇总。**作废的单不计入营业额**，但单独统计 —— 它正是老板要看的那个数。
 */
export function totalsOf(rows: LocalCheck[]): Totals {
  const t: Totals = {
    revenueCents: 0, buffetGuests: 0, drinkCount: 0,
    openCount: 0, closedCount: 0, voidedCount: 0, voidedCents: 0,
  }
  for (const c of rows) {
    if (c.status === 'voided') {
      t.voidedCount++
      t.voidedCents += c.est_cents
      continue
    }
    if (c.status === 'open') t.openCount++
    else t.closedCount++
    t.revenueCents += c.est_cents
    t.buffetGuests += c.adult + c.child + c.senior
    t.drinkCount += c.drink_adult + c.drink_child
  }
  return t
}

/** 开桌。写本地 + 排队，**不等网络**。 */
export async function openTable(
  tableLabel: string,
  guests: Guests,
  drinks: Drinks,
): Promise<string> {
  const payload = { table_label: tableLabel, guests, drinks }
  // enqueue 内部生成 op_id，这里要拿到它作为 check_uuid，
  // 所以先自己生成再传进去
  const opId = uuid()
  await enqueue('open_check', payload, opId)
  await applyCheckOp('open_check', opId, payload, new Date().toISOString(), {
    synced: 0,
    remote: 0,
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
  })
}

/** 楼面：桌号 → 未结账单。 */
export async function openChecksByTable(): Promise<Map<string, LocalCheck>> {
  const rows = await db.checks.where('status').equals('open').toArray()
  const m = new Map<string, LocalCheck>()
  for (const r of rows) m.set(r.table_label, r)
  return m
}
