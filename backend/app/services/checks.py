"""开桌 / 关单的业务副作用。

**所有写入都走 sync，没有第二条路。**
一条写入路径 = 一套不变量。如果开桌既能走 REST 又能走 sync，
两边的校验迟早会漂移，而漂移出来的洞只有在对账时才会被发现。
"""

import uuid as uuidlib
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import DiningCheck, DiningTable, HeadCharge
from .period import resolve_period
from .pricing import resolve_head_prices

GUEST_TYPES = ("adult", "child", "senior")
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
