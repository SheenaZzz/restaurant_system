"""开桌 / 关单的业务副作用。

**所有写入都走 sync，没有第二条路。**
一条写入路径 = 一套不变量。如果开桌既能走 REST 又能走 sync，
两边的校验迟早会漂移，而漂移出来的洞只有在对账时才会被发现。
"""

import uuid as uuidlib
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from sqlalchemy import func

from ..models import (
    CheckException,
    DiningCheck,
    DiningTable,
    HeadCharge,
    MenuItem,
    OrderLine,
    PickupOrder,
    ServicePeriod,
    TaxRate,
)
from .period import resolve_period
from .pricing import resolve_head_prices

GUEST_TYPES = ("adult", "child", "senior")

# --- 大桌服务费 ---
# 5 人及以上收 10%。
# ⚠️ 先写成常量。等费率真要调整时应该挪进配置表（像 buffet_price 那样带
#    effective_from），否则改一次费率会影响历史账单的重算结果。
#    落库的 service_charge_rate 快照保证了**已有账单**不受影响。
LARGE_PARTY_MIN = 5
SERVICE_CHARGE_RATE = Decimal("0.10")


def _party_size(db: Session, check_id: int) -> int:
    """估计这桌有几个人。

    我们只记录了「吃 buffet 的人数」和「要饮料的份数」，没有单独记
    「坐了几个人」。只喝饮料不吃自助的人**也占座位、也算在大桌人数里**，
    所以取两者的最大值：
      - 6 人吃、2 人喝 → 至少 6 人
      - 3 人吃、5 人喝 → 至少 5 人

    这是从现有数据能得到的最好估计。如果店里对「几人」有更严格的口径，
    需要在开桌时单独记一个座位数字段。
    """
    rows = db.execute(
        select(HeadCharge.kind, func.sum(HeadCharge.qty))
        .where(HeadCharge.check_id == check_id)
        .group_by(HeadCharge.kind)
    ).all()
    by_kind = {k: int(v or 0) for k, v in rows}
    return max(by_kind.get("admission", 0), by_kind.get("drink", 0))


def _current_tax_rate(db: Session, on: date) -> Decimal:
    """取某个营业日适用的税率。没配过就是 0（不收税）。"""
    r = db.scalar(
        select(TaxRate.rate)
        .where(TaxRate.effective_from <= on)
        .order_by(TaxRate.effective_from.desc())
        .limit(1)
    )
    return Decimal(str(r)) if r is not None else Decimal("0")


def _recalc_service_charge(db: Session, chk: DiningCheck) -> None:
    """按当前人数重算服务费**和税**。每次金额或人数变动后都要调用。

    并桌是最容易触发服务费的场景：两桌各 3 人本来都不收，
    并成 6 人就要收了 —— 这正是这个函数存在的理由。
    """
    db.flush()  # 让刚 add 的 head_charge 参与统计

    size = _party_size(db, chk.id)

    head = db.scalar(
        select(func.coalesce(func.sum(HeadCharge.qty * HeadCharge.unit_price_cents), 0))
        .where(HeadCharge.check_id == chk.id)
    ) or 0
    # 单点菜品也要计入服务费基数（退掉的不算）
    lines = db.scalar(
        select(func.coalesce(func.sum(OrderLine.qty * OrderLine.unit_price_cents), 0))
        .where(OrderLine.check_id == chk.id, OrderLine.status != "voided")
    ) or 0
    subtotal = int(head + lines)

    # --- 大桌服务费 ---
    if size >= LARGE_PARTY_MIN:
        # 四舍五入到分。用 Decimal 而不是浮点 —— 钱不能用 float。
        chk.service_charge_cents = int(
            (Decimal(subtotal) * SERVICE_CHARGE_RATE).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP
            )
        )
        chk.service_charge_rate = SERVICE_CHARGE_RATE
    else:
        chk.service_charge_cents = 0
        chk.service_charge_rate = None

    # --- 税 ---
    # 税基 = 小计 + 服务费。
    # ⚠️ 强制性服务费在多数州是应税的（自愿给的小费才免税），
    #    我们这 10% 是满 5 人自动加的，属于强制性，所以计入税基。
    #    如果店里的会计口径不同，改这一行即可。
    period = db.get(ServicePeriod, chk.period_id)
    on = period.business_date if period else date.today()
    rate = _current_tax_rate(db, on)
    base = subtotal + chk.service_charge_cents
    chk.tax_cents = int(
        (Decimal(base) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    )
    chk.tax_rate = rate if rate > 0 else None
# 饮料只有成人/儿童两档 —— 长者饮料按成人价，这是店里的实际做法
DRINK_TIERS = ("adult", "child")


def _parse_drinks(raw) -> dict[str, int]:
    """解析饮料数量，**同时兼容新旧两种 payload 格式**。

        新：{"adult": 2, "child": 1}
        旧：3            （等价于 {"adult": 3}）

    ⚠️ 为什么必须兼容旧格式：这是个离线优先系统 ——
    某台 iPad 的 outbox 里可能还躺着升级前排队的 op，
    它带的是旧格式。如果新服务端不认，那些单会被拒进死信队列，
    等于**因为一次发版丢了真实营业数据**。
    离线系统改 payload 格式，兼容期是必须的，不是可选的。
    """
    if isinstance(raw, bool):
        raise BusinessError(f"饮料数非法: {raw!r}")

    if isinstance(raw, int):
        if raw < 0:
            raise BusinessError(f"饮料数非法: {raw!r}")
        return {"adult": raw} if raw else {}

    if isinstance(raw, dict):
        out: dict[str, int] = {}
        for tier in DRINK_TIERS:
            n = raw.get(tier, 0)
            if isinstance(n, bool) or not isinstance(n, int) or n < 0:
                raise BusinessError(f"饮料数非法: {tier}={n!r}")
            if n:
                out[tier] = n
        unknown = set(raw) - set(DRINK_TIERS)
        if unknown:
            # senior 会走到这里 —— 明确报错而不是静默丢弃，
            # 静默丢弃等于少收钱
            raise BusinessError(f"饮料档位不支持: {sorted(unknown)}（只有成人/儿童）")
        return out

    raise BusinessError(f"饮料数非法: {raw!r}")


class BusinessError(ValueError):
    """业务规则拒绝。会被 sync 层转成 rejected，进客户端死信队列。"""


def open_check(db: Session, op_id: uuidlib.UUID, payload: dict, client_ts: datetime,
               user_id: int | None) -> None:
    """开一张堂食单：dining_check + 若干 head_charge。

    payload = {
      "table_label": "A7",
      "guests": {"adult": 2, "child": 1, "senior": 0},
      "drinks": {"adult": 2, "child": 1}   # 也接受旧格式的整数
    }
    """
    label = payload.get("table_label")
    if not isinstance(label, str) or not label:
        raise BusinessError("缺少 table_label")

    table = db.scalar(select(DiningTable).where(DiningTable.label == label))
    if table is None:
        raise BusinessError(f"桌号不存在: {label}")

    guests_raw = payload.get("guests") or {}
    guests: dict[str, int] = {}
    for g in GUEST_TYPES:
        n = guests_raw.get(g, 0)
        if not isinstance(n, int) or n < 0:
            raise BusinessError(f"人数非法: {g}={n!r}")
        if n:
            guests[g] = n

    drinks = _parse_drinks(payload.get("drinks", 0))

    total_guests = sum(guests.values())
    total_drinks = sum(drinks.values())

    # ⚠️ 饮料数**可以超过**吃 buffet 的人数 ——
    #    陪同的人不吃自助、只要一杯饮料，是很常见的情况。
    #    （原本这里挡了 drinks > guests，是把业务规则想窄了。）
    #
    #    由此产生的一个建模后果：admission 的人数 = **吃 buffet 的人数**，
    #    不等于坐在桌上的人数。后面做消耗率预测时要的正是前者
    #    （只有吃的人才消耗菜），所以这个口径是对的 —— 但如果将来
    #    要统计真实上座率，需要另外记一个字段。
    if total_guests == 0 and total_drinks == 0:
        raise BusinessError("至少要有一位客人或一份饮料")

    # ⚠️ 用 op 的 client_ts 而不是服务端当前时间：
    # 离线两小时后补发的单，必须落在**当时**那个营业时段里
    period = resolve_period(db, client_ts)
    prices = resolve_head_prices(db, period.kind, period.business_date)

    chk = DiningCheck(
        client_uuid=op_id,
        table_id=table.id,
        period_id=period.id,
        source="dine_in",
        status="open",
        opened_at=client_ts,
        opened_by=user_id,
    )
    db.add(chk)
    # flush 让 uq_check_open_per_table 立刻生效 ——
    # 两个服务员离线各开了同一张桌，第二条要在这里就炸掉
    db.flush()

    for g, n in guests.items():
        price = prices.get(("admission", g))
        if price is None:
            raise BusinessError(f"没有 {period.kind}/{g} 的价格配置")
        db.add(
            HeadCharge(
                check_id=chk.id,
                kind="admission",
                guest_type=g,
                qty=n,
                unit_price_cents=price,
            )
        )

    for tier, n in drinks.items():
        price = prices.get(("drink", tier))
        if price is None:
            raise BusinessError(f"没有 {period.kind}/{tier} 的饮料价格配置")
        db.add(
            HeadCharge(
                check_id=chk.id,
                kind="drink",
                guest_type=tier,
                qty=n,
                unit_price_cents=price,
            )
        )

    _recalc_service_charge(db, chk)


def close_check(db: Session, payload: dict, client_ts: datetime) -> None:
    """关单。**只关单，不处理收款** —— 收款走店里现有方式。"""
    raw = payload.get("check_uuid")
    try:
        cu = uuidlib.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        raise BusinessError(f"check_uuid 非法: {raw!r}") from None

    chk = db.scalar(select(DiningCheck).where(DiningCheck.client_uuid == cu))
    if chk is None:
        raise BusinessError("账单不存在（可能开桌那条还没同步上来）")

    # 已经关过就当成功 —— 幂等。两台设备同时点结账不该报错。
    if chk.status == "closed":
        return
    if chk.status == "voided":
        raise BusinessError("账单已作废，不能关单")

    chk.status = "closed"
    chk.closed_at = client_ts

    if "payment" in payload:
        _apply_payment(chk, payload.get("payment"))


def _load_check(db: Session, payload: dict) -> DiningCheck:
    raw = payload.get("check_uuid")
    try:
        cu = uuidlib.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        raise BusinessError(f"check_uuid 非法: {raw!r}") from None

    chk = db.scalar(select(DiningCheck).where(DiningCheck.client_uuid == cu))
    if chk is None:
        raise BusinessError("账单不存在（可能开桌那条还没同步上来）")
    return chk


def modify_check(db: Session, payload: dict, client_ts: datetime) -> None:
    """改单：整体替换人数与饮料。

    payload = {"check_uuid": ..., "guests": {...}, "drinks": {...}}

    **用整体替换而不是增量调整。** 增量（"成人 +1"）在离线重放时会出错：
    两台设备各自 +1，重放后变成 +2，但操作者的意图是"最终是 3 人"。
    整体替换是幂等的 —— 重放多少次结果都一样。

    价格用**这张单当初所属时段**的价格重算，不是当前时段 ——
    晚上改一张午市的单，不能按晚市价收。
    """
    chk = _load_check(db, payload)
    # 已结账的单**也允许改** —— 结完账才发现录错人数是常事。
    # 唯一挡住的是已作废：要先撤销作废再改，否则语义含糊
    #（改一张作废单意味着什么？）。
    if chk.status == "voided":
        raise BusinessError("已作废的单请先撤销作废再修改")

    guests: dict[str, int] = {}
    guests_raw = payload.get("guests") or {}
    for g in GUEST_TYPES:
        n = guests_raw.get(g, 0)
        if isinstance(n, bool) or not isinstance(n, int) or n < 0:
            raise BusinessError(f"人数非法: {g}={n!r}")
        if n:
            guests[g] = n

    drinks = _parse_drinks(payload.get("drinks", 0))
    if sum(guests.values()) == 0 and sum(drinks.values()) == 0:
        raise BusinessError("至少要有一位客人或一份饮料")

    period = db.get(ServicePeriod, chk.period_id)
    if period is None:
        raise BusinessError("账单所属营业时段丢失")
    prices = resolve_head_prices(db, period.kind, period.business_date)

    # 先删后加。sync_op 里留着完整的改单历史，所以审计不受影响。
    db.query(HeadCharge).filter(HeadCharge.check_id == chk.id).delete(
        synchronize_session=False
    )

    for g, n in guests.items():
        price = prices.get(("admission", g))
        if price is None:
            raise BusinessError(f"没有 {period.kind}/{g} 的价格配置")
        db.add(
            HeadCharge(
                check_id=chk.id, kind="admission", guest_type=g,
                qty=n, unit_price_cents=price,
            )
        )
    for tier, n in drinks.items():
        price = prices.get(("drink", tier))
        if price is None:
            raise BusinessError(f"没有 {period.kind}/{tier} 的饮料价格配置")
        db.add(
            HeadCharge(
                check_id=chk.id, kind="drink", guest_type=tier,
                qty=n, unit_price_cents=price,
            )
        )

    _recalc_service_charge(db, chk)


def void_check(db: Session, payload: dict, client_ts: datetime,
               user_id: int | None) -> None:
    """作废整张单，并**强制留下原因**。

    作废是唯一能让一整张单的钱凭空消失的操作，所以它必须：
      ① 有原因（不许空）
      ② 可归因到人
      ③ 在异常表里留痕，进老板的报表
    """
    chk = _load_check(db, payload)
    if chk.status == "voided":
        return  # 幂等

    reason = payload.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise BusinessError("作废必须填写原因")

    head = db.scalar(
        select(func.coalesce(func.sum(HeadCharge.qty * HeadCharge.unit_price_cents), 0))
        .where(HeadCharge.check_id == chk.id)
    ) or 0
    lines_amt = db.scalar(
        select(func.coalesce(func.sum(OrderLine.qty * OrderLine.unit_price_cents), 0))
        .where(OrderLine.check_id == chk.id, OrderLine.status != "voided")
    ) or 0
    amount = int(head) + int(lines_amt) + chk.service_charge_cents + chk.tax_cents

    # 记下作废前是什么状态，撤销时恢复成它。
    # **不动 closed_at** —— 那是结账时间，跟作废是两回事。
    chk.pre_void_status = chk.status
    chk.status = "voided"
    chk.voided_at = client_ts

    db.add(
        CheckException(
            check_id=chk.id,
            kind="void",
            amount_cents=int(amount),
            reason=reason.strip(),
            recorded_by=user_id,
            recorded_at=client_ts,
        )
    )


def restore_check(db: Session, payload: dict, client_ts: datetime,
                  user_id: int | None) -> None:
    """撤销作废，把单恢复回作废前的状态。

    作废是可逆的 —— 误作废是很常见的操作失误，没有撤销就只能重新录一遍，
    而重录会丢掉原始的开台时间和操作人。

    **不删除原来的作废记录**，只在上面盖一个"已撤销"的戳。
    "先作废一张 $120 的单、十分钟后又恢复" 本身就是老板该看见的信号；
    删掉记录等于把这个信号也删了。

    原因**选填** —— 危险的方向（作废）要求说明理由，
    纠错的方向（恢复）不该增加摩擦。
    """
    chk = _load_check(db, payload)
    if chk.status != "voided":
        return  # 幂等：已经是正常状态

    reason = payload.get("reason")
    reason = reason.strip() if isinstance(reason, str) and reason.strip() else None

    target = chk.pre_void_status or "open"

    # ⚠️ 真实边界：作废之后这张桌空出来了，很可能已经被重新开了新单。
    #    这时恢复会造成"同一张桌两张未结单"，撞唯一约束 ——
    #    数据库会挡住，但报出来是 UniqueViolation，主管看不懂。
    #    这里提前检查并给出能看懂的话。
    if target == "open" and chk.table_id is not None:
        conflict = db.scalar(
            select(DiningCheck.id).where(
                DiningCheck.table_id == chk.table_id,
                DiningCheck.status == "open",
                DiningCheck.id != chk.id,
            )
        )
        if conflict is not None:
            table = db.get(DiningTable, chk.table_id)
            raise BusinessError(
                f"{table.label if table else '该桌'} 已经有另一张未结账单，"
                "无法恢复这一张。请先结掉或作废那一张。"
            )

    chk.status = target
    chk.pre_void_status = None
    chk.voided_at = None

    # 给最近一条未撤销的作废记录盖戳
    exc = db.scalars(
        select(CheckException)
        .where(
            CheckException.check_id == chk.id,
            CheckException.kind == "void",
            CheckException.reverted_at.is_(None),
        )
        .order_by(CheckException.recorded_at.desc())
        .limit(1)
    ).first()
    if exc is not None:
        exc.reverted_at = client_ts
        exc.reverted_by = user_id
        exc.revert_reason = reason


# ---------------------------------------------------------------------------
# 支付方式（**只是记录**，系统不处理收款）
# ---------------------------------------------------------------------------

PAYMENT_METHODS = ("cash", "card", "mixed", "other")


def _apply_payment(chk: DiningCheck, raw) -> None:
    """写入支付方式。

    为什么要记：系统不碰钱，所以日结时**唯一的交叉验证**就是
    "系统算出来各种方式各收多少" 对上 "卡机和钱箱里实际有多少"。
    不记方式，差额就无从归因 —— 只知道差了 30 块，不知道差在现金还是卡上。
    """
    if raw is None:
        chk.payment_method = None
        chk.paid_cash_cents = chk.paid_card_cents = chk.paid_other_cents = None
        chk.payment_note = None
        return

    if not isinstance(raw, dict):
        raise BusinessError(f"payment 格式非法: {raw!r}")

    method = raw.get("method")
    if method not in PAYMENT_METHODS:
        raise BusinessError(f"支付方式非法: {method!r}（现金/刷卡/混合/其它）")

    def amt(key: str) -> int:
        v = raw.get(key, 0)
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise BusinessError(f"金额非法: {key}={v!r}")
        return v

    cash, card, other = amt("cash_cents"), amt("card_cents"), amt("other_cents")

    if method == "mixed" and sum(x > 0 for x in (cash, card, other)) < 2:
        raise BusinessError("选了「混合」但只填了一种方式的金额")

    note = raw.get("note")
    note = note.strip() if isinstance(note, str) and note.strip() else None
    if method == "other" and not note:
        raise BusinessError("选「其它」时必须说明（例如 gift card）")

    chk.payment_method = method
    chk.paid_cash_cents = cash
    chk.paid_card_cents = card
    chk.paid_other_cents = other
    chk.payment_note = note


def set_payment(db: Session, payload: dict, client_ts: datetime) -> None:
    """事后修改支付方式。

    权限给到普通员工而不是只给主管 —— 记错方式不会让钱变少，
    而每次改都要找主管的摩擦太大，反而会导致干脆不记。
    谁改的记在 sync_op 里，审计不受影响。
    """
    chk = _load_check(db, payload)
    if chk.status == "voided":
        raise BusinessError("已作废的单不能改支付方式")
    _apply_payment(chk, payload.get("payment"))


# ---------------------------------------------------------------------------
# 换桌 / 并桌
# ---------------------------------------------------------------------------


def transfer_check(db: Session, payload: dict, client_ts: datetime) -> None:
    """换桌：客人吃到一半挪到别的桌。

    权限给普通员工 —— 这是日常操作，不涉及金额。
    """
    chk = _load_check(db, payload)
    if chk.status in ("voided", "merged"):
        raise BusinessError(f"{chk.status} 状态的单不能换桌")

    label = payload.get("to_table_label")
    if not isinstance(label, str) or not label:
        raise BusinessError("缺少目标桌号")

    target = db.scalar(select(DiningTable).where(DiningTable.label == label))
    if target is None:
        raise BusinessError(f"桌号不存在: {label}")
    if target.id == chk.table_id:
        return  # 幂等：已经在这张桌上

    # 只有未结单才占桌 —— 已结账的单换桌不会冲突
    if chk.status == "open":
        busy = db.scalar(
            select(DiningCheck.id).where(
                DiningCheck.table_id == target.id,
                DiningCheck.status == "open",
                DiningCheck.id != chk.id,
            )
        )
        if busy is not None:
            raise BusinessError(f"{label} 已有未结账单，不能换过去（可以考虑并桌）")

    chk.table_id = target.id


def merge_checks(db: Session, payload: dict, client_ts: datetime) -> None:
    """并桌：几桌拼成一个大桌，合成一张单。

    payload = {"check_uuid": 目标单, "source_uuids": [被并入的单...]}

    **把明细搬到目标单，源单标记为 merged。**
    这样营业额只算一次 —— 如果保留源单各自的明细再去"合计显示"，
    统计口径会变得很容易出错（哪些算、哪些不算）。
    搬完之后源单是空的，状态 merged，不计入任何统计。

    ⚠️ 目前**不支持拆回**。真要拆只能作废后重开 ——
    合并在店里是低频操作，先不为它增加复杂度。
    """
    target = _load_check(db, payload)
    if target.status not in ("open", "closed"):
        raise BusinessError(f"{target.status} 状态的单不能作为并桌目标")

    raw = payload.get("source_uuids")
    if not isinstance(raw, list) or not raw:
        raise BusinessError("缺少要并入的账单")

    for item in raw:
        try:
            su = uuidlib.UUID(str(item))
        except (ValueError, TypeError):
            raise BusinessError(f"source_uuid 非法: {item!r}") from None
        if su == target.client_uuid:
            raise BusinessError("不能把一张单并入它自己")

        src = db.scalar(select(DiningCheck).where(DiningCheck.client_uuid == su))
        if src is None:
            raise BusinessError("要并入的账单不存在（可能还没同步上来）")
        if src.status == "merged":
            continue  # 幂等
        if src.status not in ("open", "closed"):
            raise BusinessError(f"{src.status} 状态的单不能并桌")

        # 明细搬家。同 kind+guest_type 的行会并存，统计时求和，
        # 不合并成一行 —— 保留"这几个人原本坐哪桌"的痕迹意义不大，
        # 但拆成多行至少能看出这是并过桌的。
        db.query(HeadCharge).filter(HeadCharge.check_id == src.id).update(
            {"check_id": target.id}, synchronize_session=False
        )
        src.status = "merged"
        src.merged_into = target.client_uuid
        src.service_charge_cents = 0
        src.service_charge_rate = None

    # 并完之后人数变了 —— 两桌各 3 人本来都不收服务费，
    # 并成 6 人就要收了。这是并桌最容易被忽略的后果。
    _recalc_service_charge(db, target)


# ---------------------------------------------------------------------------
# Buffet 外带（称重）
# ---------------------------------------------------------------------------

TOGO_ITEM_EN = "Buffet To-Go (by weight)"


def togo_sale(db: Session, op_id: uuidlib.UUID, payload: dict,
              client_ts: datetime, user_id: int | None) -> None:
    """一笔 buffet 外带。

    payload = {"amount_cents": 1875, "payment": {...}}

    和堂食完全不同的三点：
      - **没有桌号** —— 柜台交易，不占座
      - **没有人头** —— 秤直接给出金额，我们不知道也不需要知道几个人
      - **没有服务费** —— 大桌服务费是针对堂食大桌的

    金额落在 order_line 上（qty=1，unit_price 就是称出来的钱），
    而不是 head_charge —— head_charge 的语义是"按人头"，
    硬塞一个 qty=1 的行进去，后面算客流时就会把它当成一个人。

    **一步到位创建并结账** —— 外带是当场付清的，不存在"未结的外带单"。
    做成两步（先开单再结账）只会在断网重放时多一次失败机会。
    """
    amount = payload.get("amount_cents")
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        raise BusinessError(f"金额非法: {amount!r}")

    item = db.scalar(select(MenuItem).where(MenuItem.name_en == TOGO_ITEM_EN))
    if item is None:
        raise BusinessError("外带项目未配置（请先跑 seed）")

    period = resolve_period(db, client_ts)

    chk = DiningCheck(
        client_uuid=op_id,
        table_id=None,
        period_id=period.id,
        source="togo",
        status="closed",          # 柜台即付，直接结账
        opened_at=client_ts,
        closed_at=client_ts,
        opened_by=user_id,
    )
    db.add(chk)
    db.flush()

    db.add(
        OrderLine(
            check_id=chk.id,
            menu_item_id=item.id,
            qty=1,
            unit_price_cents=amount,
            status="served",      # 外带没有后厨流程
            placed_at=client_ts,
            ready_at=client_ts,
        )
    )

    if "payment" in payload:
        _apply_payment(chk, payload.get("payment"))


# ---------------------------------------------------------------------------
# 自提：Buffet To Go（按重量）+ 电话点菜
# ---------------------------------------------------------------------------


def _add_lines(db: Session, chk: DiningCheck, raw, client_ts: datetime) -> None:
    """把菜品加到账单上。堂食和自提共用 —— 一桌里有人吃自助、有人点菜，
    跟自提点菜在数据上是同一件事。

    价格一律服务端解析。唯一的例外是 `open_price` 的条目
    （Buffet To Go 按重量称），那种金额只能由前台从秤上读出来输入。
    """
    if not isinstance(raw, list) or not raw:
        raise BusinessError("没有要加的菜")

    for item in raw:
        if not isinstance(item, dict):
            raise BusinessError(f"菜品格式非法: {item!r}")

        mid = item.get("menu_item_id")
        if not isinstance(mid, int):
            raise BusinessError(f"menu_item_id 非法: {mid!r}")

        mi = db.get(MenuItem, mid)
        if mi is None or not mi.active:
            raise BusinessError(f"菜品不存在或已下架: {mid}")

        qty = item.get("qty", 1)
        if isinstance(qty, bool) or not isinstance(qty, int) or qty <= 0:
            raise BusinessError(f"数量非法: {qty!r}")

        if mi.open_price:
            amt = item.get("amount_cents")
            if isinstance(amt, bool) or not isinstance(amt, int) or amt <= 0:
                raise BusinessError(f"{mi.name_zh} 需要输入金额")
            price = amt
        else:
            if mi.price_cents is None:
                raise BusinessError(f"{mi.name_zh} 没有定价，不能单点")
            price = mi.price_cents

        notes = item.get("notes")
        notes = notes.strip() if isinstance(notes, str) and notes.strip() else None

        db.add(
            OrderLine(
                check_id=chk.id,
                menu_item_id=mi.id,
                qty=qty,
                # 价格快照 —— 改菜单不会改动历史账单
                unit_price_cents=price,
                notes=notes,
                status="placed",
                placed_at=client_ts,
            )
        )


def open_togo_check(db: Session, op_id: uuidlib.UUID, payload: dict,
                    client_ts: datetime, user_id: int | None) -> None:
    """开一张自提单。

    两种：
      buffet_togo  自助餐打包，秤上直接出金额，前台把数字录进来
      phone_order  电话点菜，从菜单选

    **不占桌、不算大桌服务费** —— service charge 看的是 head_charge 的人头数，
    自提单没有人头，自然是 0，不需要额外判断。
    """
    source = payload.get("source")
    if source not in ("buffet_togo", "phone_order"):
        raise BusinessError(f"自提类型非法: {source!r}")

    period = resolve_period(db, client_ts)
    chk = DiningCheck(
        client_uuid=op_id,
        table_id=None,
        period_id=period.id,
        source=source,
        status="open",
        opened_at=client_ts,
        opened_by=user_id,
    )
    db.add(chk)
    db.flush()

    _add_lines(db, chk, payload.get("lines"), client_ts)

    name = payload.get("customer_name")
    phone = payload.get("phone_last4")
    promised = payload.get("promised_at")
    if name or phone or promised:
        db.add(
            PickupOrder(
                check_id=chk.id,
                customer_name=(name or None),
                # PII 原则：只留后四位，够核对身份就行
                phone_last4=(str(phone)[-4:] if phone else None),
                promised_at=promised,
                status="placed",
            )
        )


def add_order_lines(db: Session, payload: dict, client_ts: datetime) -> None:
    """给已有账单加菜。**堂食也能用** ——
    一桌两人，一个吃自助一个点菜，就是这个场景。
    """
    chk = _load_check(db, payload)
    if chk.status not in ("open", "closed"):
        raise BusinessError(f"{chk.status} 状态的单不能加菜")

    _add_lines(db, chk, payload.get("lines"), client_ts)
    # 加菜会改变金额，大桌服务费要跟着重算
    _recalc_service_charge(db, chk)


def void_order_line(db: Session, payload: dict, client_ts: datetime) -> None:
    """退掉一道菜（做错了 / 客人不要了）。

    **不物理删除**，只把状态标成 voided —— 退菜是要进老板报表的，
    删掉就等于这道菜从没出现过。
    """
    chk = _load_check(db, payload)
    line_id = payload.get("line_id")
    if not isinstance(line_id, int):
        raise BusinessError(f"line_id 非法: {line_id!r}")

    line = db.get(OrderLine, line_id)
    if line is None or line.check_id != chk.id:
        raise BusinessError("这道菜不在这张单上")
    if line.status == "voided":
        return  # 幂等

    line.status = "voided"
    _recalc_service_charge(db, chk)
