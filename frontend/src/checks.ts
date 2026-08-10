import {
  estimateCents,
  loadCatalog,
  partySize,
  serviceCents,
  type Drinks,
  type PriceRow,
} from './catalog'
import { getIdentity } from './auth'
import db, { setMeta, uuid, type LocalCheck } from './db'
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
      est_cents: sub + svc,
      service_cents: svc,
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
    await db.checks.put({
      ...row,
      ...guests,
      drink_adult: drinks.adult,
      drink_child: drinks.child,
      est_cents: sub2 + svc2,
      service_cents: svc2,
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
      await db.checks.put({
        ...target,
        ...g,
        drink_adult: d.adult,
        drink_child: d.child,
        est_cents: sub + svc,
        service_cents: svc,
        last_by: opts.who ?? target.last_by,
        ...opts,
      })
    }
  } else if (entity === 'set_payment') {
    const row = await db.checks.get(String(payload.check_uuid ?? ''))
    if (row) await db.checks.put({ ...row, ...payFields(payload.payment), ...opts })
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
): Promise<string> {
  const payload = { table_label: tableLabel, guests, drinks }
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

/** 楼面：桌号 → 未结账单。 */
export async function openChecksByTable(): Promise<Map<string, LocalCheck>> {
  const rows = await db.checks.where('status').equals('open').toArray()
  const m = new Map<string, LocalCheck>()
  for (const r of rows) m.set(r.table_label, r)
  return m
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

/** 事后改支付方式。 */
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
