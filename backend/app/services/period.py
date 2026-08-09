"""营业时段解析。

每张账单都要挂在一个 service_period 上。前台不该手动"开市/闭市" ——
高峰期没人会记得点，忘了点就全天的单都挂不上去。所以按时间自动判定，
需要时自动建。
"""

import os
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ServicePeriod

# 店里的本地时区偏移（小时）。UTC-5 = EST。
# 之所以用固定偏移而不是 IANA 时区：营业日的切分只需要"店里的钟点"，
# 而夏令时切换那两天的边界由 BUSINESS_DAY_CUTOFF 兜底。
# Step 7 上线前应换成真实时区名，这里先保持简单可测。
STORE_UTC_OFFSET = int(os.getenv("STORE_UTC_OFFSET", "-5"))

# 午市/晚市的分界（店内本地时间）
LUNCH_TO_DINNER = time(16, 0)

# 营业日的分界。凌晨 2 点前打的单仍算前一天 ——
# 否则收市后补录的单会掉到第二天，日结对不上。
BUSINESS_DAY_CUTOFF = time(2, 0)


def store_now() -> datetime:
    return datetime.now(timezone(timedelta(hours=STORE_UTC_OFFSET)))


def business_date_of(local_dt: datetime) -> date:
    if local_dt.time() < BUSINESS_DAY_CUTOFF:
        return (local_dt - timedelta(days=1)).date()
    return local_dt.date()


def period_kind_of(local_dt: datetime) -> str:
    # 凌晨的单归到前一个营业日的晚市
    if local_dt.time() < BUSINESS_DAY_CUTOFF:
        return "dinner"
    return "lunch" if local_dt.time() < LUNCH_TO_DINNER else "dinner"


def resolve_period(db: Session, at: datetime | None = None) -> ServicePeriod:
    """拿到（必要时创建）某一时刻所属的营业时段。

    ⚠️ 用 op 的 client_ts 而不是服务端当前时间 ——
    离线两小时后补发的单，必须落在**当时**那个时段里，
    否则午市的单会被算进晚市。
    """
    local = (
        at.astimezone(timezone(timedelta(hours=STORE_UTC_OFFSET)))
        if at
        else store_now()
    )
    bdate = business_date_of(local)
    kind = period_kind_of(local)

    period = db.scalar(
        select(ServicePeriod).where(
            ServicePeriod.business_date == bdate, ServicePeriod.kind == kind
        )
    )
    if period is None:
        period = ServicePeriod(
            business_date=bdate,
            kind=kind,
            opened_at=at or datetime.now(timezone.utc),
        )
        db.add(period)
        db.flush()
    return period
