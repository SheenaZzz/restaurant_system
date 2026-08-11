"""营业时段与营业日解析。

每张账单都要挂在一个 service_period 上。前台不该手动"开市/闭市" ——
高峰期没人会记得点，忘了点就全天的单都挂不上去。所以按时间自动判定，
需要时自动建。

这个模块是**营业日口径的唯一定义处**。前端不许自己再写一份 ——
两个常量迟早漂移，而漂移出来的洞只有对账时才会发现。前端要用的值
由 /api/catalog 下发（见 api/catalog.py）。
"""

import logging
import os
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ServicePeriod, StoreSetting

log = logging.getLogger(__name__)

# env 只是**引导默认值**：数据库那一行还没建出来时（全新库、迁移之前）
# 得有个能跑的值。正常运行时一律以 store_setting 表为准，
# 老板在设置页改完立刻生效，不用重建容器 —— 店里没有 IT。
_ENV_TZ = os.getenv("STORE_TZ", "America/Los_Angeles")
_ENV_CUTOFF_HOUR = int(os.getenv("BUSINESS_DAY_CUTOFF_HOUR", "0"))

# 午市/晚市的分界（店内本地时间）。
# 菜单上印的是：午市自助 11:00–15:00，晚市自助 15:00–20:30。
# 这个印在菜单上，不做成设置项。
LUNCH_TO_DINNER = time(15, 0)


@dataclass(frozen=True)
class StoreClock:
    """店里的时间口径：所在时区 + 营业日分界。

    ⚠️ 用 IANA 时区名而不是固定偏移。
       原来写死 STORE_UTC_OFFSET=-5（EST），而店在太平洋时区 ——
       差两小时，下午 13:00 就被判成晚市，午市的单按晚市价收
       （$15.88 vs $14.05）。这是会多收客人钱的那种错。

       而且营业日分界现在是 0:00，固定偏移在夏令时切换那两天会整体
       错一小时。以前 cutoff 是凌晨 2 点，恰好把 DST 的切换点
       （也是 2:00）挡在营业日之外，所以偏移错了也看不出来；
       分界移到 0:00 之后这层缓冲没有了，必须用真时区。
    """

    tz: ZoneInfo
    cutoff_hour: int

    @property
    def cutoff(self) -> time:
        return time(self.cutoff_hour, 0)

    def now(self) -> datetime:
        """店里此刻的本地时间（带时区）。"""
        return datetime.now(self.tz)

    def local(self, at: datetime | None) -> datetime:
        """把任意时刻换算成店里的本地时间。None = 现在。

        naive 的输入按店内时间处理 —— 不猜它是 UTC。猜错的代价是
        整张单落到错误的营业日，而且不会报错。
        """
        if at is None:
            return self.now()
        if at.tzinfo is None:
            return at.replace(tzinfo=self.tz)
        return at.astimezone(self.tz)

    def business_date(self, local_dt: datetime) -> date:
        """这一刻属于哪个营业日。输入必须已经是店内本地时间。"""
        if local_dt.time() < self.cutoff:
            return (local_dt - timedelta(days=1)).date()
        return local_dt.date()

    def period_kind(self, local_dt: datetime) -> str:
        # cutoff 不为 0 时，凌晨的单归到前一个营业日的晚市。
        # cutoff = 0 时这一支不会命中，留着是为了改回 2 点时行为仍然正确。
        if local_dt.time() < self.cutoff:
            return "dinner"
        return "lunch" if local_dt.time() < LUNCH_TO_DINNER else "dinner"


def _zone(name: str) -> ZoneInfo | None:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def load_store_clock(db: Session) -> StoreClock:
    """从 store_setting 读时间口径。

    同一个 Session 里反复调用不会反复查库 —— db.get() 命中身份映射。
    所以一批 op 里每条都调一次 resolve_period 也没有额外开销。

    读不到或值非法时退回 env 默认值并**明确告警**：POS 不能因为
    设置表里一个手改坏的时区名就整店起不来，但也绝不能悄悄换一个
    口径继续跑 —— 那会静默改变所有账单的归属日。
    """
    row = db.get(StoreSetting, 1)
    if row is None:
        # 全新库、迁移还没跑到。正常运行时不会走到这里。
        return StoreClock(tz=_zone(_ENV_TZ) or ZoneInfo("UTC"), cutoff_hour=_ENV_CUTOFF_HOUR)

    tz = _zone(row.tz)
    if tz is None:
        log.error(
            "store_setting.tz=%r 不是合法的 IANA 时区名，暂时退回 %r。"
            "营业日和午/晚市判定可能不对，请到设置页重设。",
            row.tz,
            _ENV_TZ,
        )
        tz = _zone(_ENV_TZ) or ZoneInfo("UTC")

    return StoreClock(tz=tz, cutoff_hour=row.business_day_cutoff_hour)


def resolve_period(db: Session, at: datetime | None = None) -> ServicePeriod:
    """拿到（必要时创建）某一时刻所属的营业时段。

    ⚠️ 用 op 的 client_ts 而不是服务端当前时间 ——
    离线两小时后补发的单，必须落在**当时**那个时段里，
    否则午市的单会被算进晚市。
    """
    clock = load_store_clock(db)
    local = clock.local(at)
    bdate = clock.business_date(local)
    kind = clock.period_kind(local)

    period = db.scalar(
        select(ServicePeriod).where(
            ServicePeriod.business_date == bdate, ServicePeriod.kind == kind
        )
    )
    if period is None:
        period = ServicePeriod(
            business_date=bdate,
            kind=kind,
            opened_at=at or clock.now(),
        )
        db.add(period)
        db.flush()
    return period
