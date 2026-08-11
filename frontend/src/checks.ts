import {
  estimateCents,
  loadCatalog,
  partySize,
  serviceCents,
  taxCents,
  type Drinks,
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
  opts: { synced: 0 | 1; remote: 0 | 1; who?: string },
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
    const sub = estimateCents(prices, cat?.current_period_kind ?? 'dinner', guests, drinks)
    const svc = serviceCents(sub, partySize(guests, drinks))
    const tax = taxCents(sub, svc, cat?.tax_rate ?? 0)

    await db.checks.put({
      // 账单的身份就是创建它那条 op 的 op_id ——
      // 客户端离线时拿不到数据库主键，只能自己生成标识
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
        // 记下作废前的状态 —— 撤销时要恢复成它，
        // 否则一张"已结→作废"的单撤销后会变回"未结"，桌子凭空又占上了
        pre_void_status: row.status,
        status: 'voided',
        void_reason: String(payload.reason ?? ''),
      })
    }
  } else if (entity === 'open_togo_check') {
    const cat = await loadCatalog()
    const menu = new Map((cat?.menu ?? []).map((m) => [m.id, m]))
    const lines: LocalLine[] = ((payload.lines ?? []) as any[]).map((l) => {
      const mi = menu.get(l.menu_item_id)
      return {
        menu_item_id: l.menu_item_id,
        name: mi?.name_zh ?? mi?.name_en ?? `#${l.menu_item_id}`,
        qty: l.qty ?? 1,
        // 开放价条目的金额由前台输入；其余取菜单价
        unit_price_cents: mi?.open_price
          ? (l.amount_cents ?? 0)
          : (mi?.price_cents ?? 0),
        notes: l.notes,
      }
    })
    await db.checks.put({
      check_uuid: opId,
      source: payload.source === 'buffet_togo' ? 'buffet_togo' : 'phone_order',
      table_label: payload.source === 'buffet_togo' ? '自助打包' : '电话单',
      lines,
      customer_name: payload.customer_name as string | undefined,
      phone_last4: payload.phone_last4
        ? String(payload.phone_last4).slice(-4)
        : undefined,
      status: 'open',
      opened_at: clientTs,
      adult: 0, child: 0, senior: 0, drink_adult: 0, drink_child: 0,
      // 自提单没有人头，不触发大桌服务费 —— 但一样要收税
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
      const add: LocalLine[] = ((payload.lines ?? []) as any[]).map((l) => {
        const mi = menu.get(l.menu_item_id)
        return {
          menu_item_id: l.menu_item_id,
          name: mi?.name_zh ?? mi?.name_en ?? `#${l.menu_item_id}`,
          qty: l.qty ?? 1,
          unit_price_cents: mi?.open_price
            ? (l.amount_cents ?? 0)
            : (mi?.price_cents ?? 0),
          notes: l.notes,
        }
      })
      const lines = [...(row.lines ?? []), ...add]
      await db.checks.put({
        ...row,
        lines,
        est_cents: recalcEst(row, lines),
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
      // 并完人数变了，服务费可能从 0 变成有 —— 这是并桌最容易忽略的后果
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
    // 补收：**累加**，不是替换。必须和服务端 add_payment 同样的算法 ——
    // 本地镜像算出来的待收金额如果和服务端不一致，员工会照着错的数收钱。
    const row = await db.checks.get(String(payload.check_uuid ?? ''))
    if (row) {
      const p = (payload.payment ?? {}) as Partial<Payment>
      const cash = (row.pay_cash ?? 0) + (p.cash_cents ?? 0)
      const card = (row.pay_card ?? 0) + (p.card_cents ?? 0)
      const other = (row.pay_other ?? 0) + (p.other_cents ?? 0)
      // 方式由三个桶推导，不用 payload 里的 —— 一笔刷卡加一笔现金合起来是 mixed
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
        // 说明**追加**不覆盖：原来那笔的说明同样要留着
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

/** 撤销作废，恢复回作废前的状态。原因选填。 */
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
    who: (await getIdentity())?.display_name,
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
    who: (await getIdentity())?.display_name,
  })
}

/** 全部账单（含已结、已作废），按开台时间倒序。**不分营业日** —— 只给需要跨天看的地方用。 */
export async function allChecks(): Promise<LocalCheck[]> {
  const rows = await db.checks.toArray()
  return rows.sort((a, b) => b.opened_at.localeCompare(a.opened_at))
}

/** 这张单属于哪个营业日。 */
export function checkBusinessDate(c: LocalCheck, cutoffHour: number): string {
  return businessDateOf(c.opened_at, cutoffHour)
}

/**
 * 某个营业日的全部账单，按开台时间倒序。
 *
 * 清单页和「当日汇总」都必须走这个，不能用 allChecks() ——
 * 原来头部时钟显示今天、下面的营业额却是开业至今累计。
 * 那个组合比没有汇总更危险：它看起来是对的。
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
 * 跨天未结的账单 —— 不属于当前营业日、但还没结账的单。
 *
 * ⚠️ 这些单**绝不能只是从楼面消失**。开了桌、有应收、没结账，
 *    就是钱还没收到。楼面清干净但没人知道它们的存在 = 静默丢单，
 *    而这套系统是店里唯一的主记录，丢了就真没了。
 *
 * 包含自提单：电话订单没人来取、也没作废，同样是没结的账。
 */
export async function carriedOverChecks(
  bdate: string,
  cutoffHour: number,
): Promise<LocalCheck[]> {
  // ⚠️ 故意用全表扫描而不是 where('status')。索引查询会**静默排除**
  //    索引键无效的记录（outbox 那次 NaN 的坑就是这么来的）——
  //    而这个函数存在的全部意义就是"任何未结的单都不许藏起来"。
  //    一天几百条，扫一遍的代价可以忽略。
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
 * 汇总。**作废的单不计入营业额**，但单独统计 —— 它正是老板要看的那个数。
 */
export function totalsOf(rows: LocalCheck[]): Totals {
  const t: Totals = {
    revenueCents: 0, buffetGuests: 0, drinkCount: 0,
    openCount: 0, closedCount: 0, voidedCount: 0, voidedCents: 0,
    serviceCents: 0, cashCents: 0, cardCents: 0, otherCents: 0,
  }
  for (const c of rows) {
    // merged 的单明细已搬到目标单，自己不再计入任何统计
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

/** 开桌。写本地 + 排队，**不等网络**。 */
export async function openTable(
  tableLabel: string,
  guests: Guests,
  drinks: Drinks,
  /** 开桌时就点的菜 —— 整桌不吃自助、直接点餐的场景 */
  lines: NewLine[] = [],
): Promise<string> {
  const payload = { table_label: tableLabel, guests, drinks, lines }
  // enqueue 内部生成 op_id，这里要拿到它作为 check_uuid，
  // 所以先自己生成再传进去
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
 * 楼面：桌号 → **当前营业日**的未结账单。
 *
 * 跨天的未结单不在这里 —— 楼面每天从干净的开始。它们由
 * carriedOverChecks() 单独列出来处理，见 CarriedOver.tsx。
 */
export async function openChecksByTable(
  bdate: string,
  cutoffHour: number,
): Promise<Map<string, LocalCheck>> {
  const rows = await db.checks.toArray()
  const m = new Map<string, LocalCheck>()
  // ⚠️ 只认堂食。自提单没有桌位，混进楼面会占掉一个格子。
  //    `source` 缺失的是加这个字段之前的老数据 —— 那时只有堂食，所以当堂食处理。
  for (const r of rows) {
    if (r.status !== 'open') continue
    if (!isDineIn(r)) continue
    if (checkBusinessDate(r, cutoffHour) !== bdate) continue
    m.set(r.table_label, r)
  }
  return m
}

/**
 * 桌号 → 跨天未结的堂食单。楼面开桌前要拿它挡一道。
 *
 * 为什么必须挡：服务端有唯一偏索引 uq_check_open_per_table
 * （一张桌同时只能有一张未结账单）。昨天那张单还在服务端占着位，
 * 今天在同一张桌开新单**会被服务端拒绝**、掉进死信队列。
 * 楼面上那张桌看起来是空的，员工点了却没反应 —— 这正是高峰期
 * 最让人放弃使用系统的那种失败。
 *
 * 所以在这里提前拦住并给出能自己解决的提示。约束负责保证正确性，
 * 错误信息负责让人知道下一步做什么 —— 和 restore_check 那次一个道理。
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

/** 老数据没有 source 字段。那时只有堂食，所以缺失即堂食。 */
export function isDineIn(c: LocalCheck): boolean {
  return c.source === undefined || c.source === 'dine_in'
}

/** 自提用**白名单**判断，不用"不是堂食"—— 后者会把老数据和将来的新类型一起放进来。 */
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

/** 换桌。日常操作，普通员工即可。 */
export async function transferTable(checkUuid: string, toLabel: string): Promise<void> {
  const payload = { check_uuid: checkUuid, to_table_label: toLabel }
  const opId = uuid()
  await enqueue('transfer_check', payload, opId)
  await applyCheckOp('transfer_check', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
}

/** 并桌：把若干张单并进目标单。**并完可能触发大桌服务费。** */
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

/** 关单并记录支付方式。 */
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

/** 事后改支付方式。**整体替换** —— 用于"方式录错了"。 */
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
 * 补收差额。**在已收金额上累加** —— 用于"结完账又加了菜"。
 *
 * 和 updatePayment 是两件事，不能合并：走替换的话，补收的 $6.99
 * 会把原来那笔 $55.47 冲掉，「支付与账单不符」反而更严重。
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

/** 已收合计。 */
export function paidCents(c: LocalCheck): number {
  return (c.pay_cash ?? 0) + (c.pay_card ?? 0) + (c.pay_other ?? 0)
}

/**
 * 待收差额（正数 = 还欠，负数 = 多收了该退）。
 *
 * 结完账又加菜就会出现正的差额；退了菜则是负的。
 * 月报里那条「支付与账单不符」抓的就是这个数不为 0 的单。
 */
export function dueCents(c: LocalCheck): number {
  if (!c.pay_method) return 0 // 还没记过支付，谈不上差额
  return c.est_cents - paidCents(c)
}


/**
 * 哪些账单还有操作没上传。
 *
 * ⚠️ **从 outbox 实时推导，不存状态。**
 *
 * 原来在 LocalCheck 上存了个 `synced` 字段，同步成功后按 op_id 去标记。
 * 但那只对开桌成立 —— 开桌那条 op 的 id 恰好就是账单 id。
 * 结账/改单/换桌用的是**新的 op_id**，标记匹配不上，
 * 于是那张单会**永远显示"待同步"**，而它其实早就上传成功了。
 *
 * 一个永远不消失的警告等于没有警告：员工看两次就学会无视它，
 * 真出问题时也不会再看。所以这里改成算出来的 ——
 * outbox 里没有引用它的 op，它就是干净的，不可能算错。
 */
export async function pendingCheckUuids(): Promise<Set<string>> {
  const ops = await db.outbox.toArray()
  const out = new Set<string>()
  for (const o of ops) {
    if (o.entity === 'open_check') {
      // 开桌：账单的身份就是这条 op 的 id
      out.add(o.op_id)
      continue
    }
    const cu = o.payload?.check_uuid
    if (typeof cu === 'string') out.add(cu)
    // 并桌还会影响被并入的那几张
    const srcs = o.payload?.source_uuids
    if (Array.isArray(srcs)) for (const x of srcs) if (typeof x === 'string') out.add(x)
  }
  return out
}

/** 本地镜像保留多少个营业日。够查「昨天那单怎么回事」，又不会无限长。 */
export const LOCAL_KEEP_DAYS = 7

/**
 * 归档：把很久以前、已经结清且已上传的账单从**本地镜像**删掉。
 *
 * 只删本机缓存，**服务端一条不动** —— 月报读的是服务端，历史照样查得到。
 *
 * 为什么需要：本地镜像原本只增不减，而楼面和清单每 2 秒轮询一次、
 * 每次都要全表扫一遍算营业日。一年下来几万条，iPad 上会肉眼可见地卡。
 * 本地镜像的用途是"断网时当天照样能干活"，不是当档案库。
 *
 * 三条都满足才删，任何一条不满足就留着：
 *   · 已结账/已作废/已并单 —— 未结的单永远留着，那是还没收到的钱
 *   · 已经上传成功     —— 没确认的绝不删，删了就是丢单
 *   · 早于保留窗口
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
      // outbox 里还有引用它的 op —— 那条 op 重放时要能找到这张单
      if (pending.has(c.check_uuid)) return false
      const bd = checkBusinessDate(c, cutoffHour)
      // 空串 = 时间戳坏了。算不出营业日的单一律留着让人能看见，
      // 不能因为算不出来就删掉。
      if (!bd) return false
      return bd < oldest
    })
    .map((c) => c.check_uuid)

  if (doomed.length) await db.checks.bulkDelete(doomed)
  return doomed.length
}


/**
 * 清空本机的账单镜像，重新从服务端拉一遍。
 *
 * 什么时候需要：服务端的数据被清过（重测、修数据），而本机镜像还留着
 * 早就不存在的单 —— 服务端删数据不会通知客户端，只有客户端自己重来。
 *
 * ⚠️ **outbox 不为空时拒绝执行。** 那里面是还没上传的真实操作，
 * 清掉就是丢单。宁可让人先等它同步完，也不能"顺手"帮他删掉。
 *
 * 保留登录状态、设备 id 和菜单缓存 —— 重置的是"业务数据"，
 * 不是"这台设备是谁"。
 */
export async function resetLocalData(): Promise<{ ok: boolean; pending: number }> {
  const pending = await db.outbox.count()
  if (pending > 0) return { ok: false, pending }

  await db.transaction('rw', db.checks, db.events, db.deadletter, db.meta, async () => {
    await db.checks.clear()
    await db.events.clear()
    await db.deadletter.clear()
    // 游标归零 —— 下次同步会把服务端现有的变更全部重新拉一遍，
    // 本地镜像由此重建。这是事件溯源的直接好处：不需要"导入数据"。
    await setMeta('cursor', 0)
  })
  return { ok: true, pending: 0 }
}


/** 本地重算总额：人头 + 单点 + 服务费。仅供显示，落库以服务端为准。 */
function recalcEst(row: LocalCheck, lines: LocalLine[]): number {
  const head = row.est_cents - (row.service_cents ?? 0) - (row.tax_cents ?? 0) -
    (row.lines ?? []).filter((l) => !l.voided)
      .reduce((a, l) => a + l.qty * l.unit_price_cents, 0)
  const lineSum = lines
    .filter((l) => !l.voided)
    .reduce((a, l) => a + l.qty * l.unit_price_cents, 0)
  const size = Math.max(
    row.adult + row.child + row.senior,
    row.drink_adult + row.drink_child,
  )
  const svc = serviceCents(head + lineSum, size)
  // 注意：税率从缓存的 catalog 拿不到（这是同步函数），
  // 所以按原比例估。真实金额以服务端为准 —— 这只是显示用。
  const taxRatio = row.est_cents > 0 ? (row.tax_cents ?? 0) / row.est_cents : 0
  const beforeTax = head + lineSum + svc
  return Math.round(beforeTax * (1 + taxRatio))
}

export interface NewLine {
  menu_item_id: number
  qty: number
  amount_cents?: number
  notes?: string
}

/** 开一张自提单（Buffet To Go 或 电话点菜）。 */
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

/** 给已有账单加菜 —— **堂食也能用**（一桌里有人吃自助有人点菜）。 */
export async function addLines(checkUuid: string, lines: NewLine[]): Promise<void> {
  const payload = { check_uuid: checkUuid, lines }
  const opId = uuid()
  await enqueue('add_order_lines', payload, opId)
  await applyCheckOp('add_order_lines', opId, payload, new Date().toISOString(), {
    synced: 0, remote: 0, who: (await getIdentity())?.display_name,
  })
}


/** payload 里的菜转成本地明细（补上菜名和价格）。 */
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
