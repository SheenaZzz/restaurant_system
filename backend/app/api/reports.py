"""报表：按营业日汇总。

**权威数字只能从服务端算。** 客户端本地镜像里的金额是按缓存价估的，
而且只包含这台设备同步到的部分 —— 拿它做月报会算错。
代价是月报需要联网，但那不是关键路径（关键路径是开桌/关单，那些离线可用）。
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser, require_role
from ..db import get_db
from ..models import DailyBatch, StoreSetting, TaxRate
from ..services.period import load_store_clock

router = APIRouter(prefix="/api/reports", tags=["reports"])


class DayRow(BaseModel):
    business_date: date
    revenue_cents: int
    service_cents: int
    tax_cents: int
    guests: int
    drinks: int
    check_count: int
    cash_cents: int
    card_cents: int
    other_cents: int
    unpaid_count: int
    # 已记支付、但支付金额和账单金额对不上的单数。
    # 最常见的成因：结账之后又改了单，支付金额没跟着改。
    # 日结对账对不上时，先看这个数。
    mismatch_count: int
    voided_cents: int
    voided_count: int
    # 小费**不是系统算出来的** —— 卡机小费和桌上现金都在系统之外，
    # 只能人工录入。所以它跟营业额的性质完全不同：
    # 营业额是"应该收到多少"，小费是"实际拿到多少"。
    tips_total_cents: int
    tips_updated_by: str | None


# 只有主管和老板能看整月营业额 —— 普通服务员没有理由看到全店经营数字。
# 这不是不信任，是最小权限：能看见的人越少，泄露面越小。
_GUARD = Depends(require_role("front_manager", "admin"))

_SQL = text(
    """
    WITH per_check AS (
        SELECT c.id,
               p.business_date,
               c.status,
               COALESCE(SUM(h.qty * h.unit_price_cents), 0)              AS subtotal,
               c.service_charge_cents                                    AS svc,
               c.tax_cents                                               AS tax,
               COALESCE(SUM(h.qty) FILTER (WHERE h.kind = 'admission'), 0) AS guests,
               COALESCE(SUM(h.qty) FILTER (WHERE h.kind = 'drink'), 0)     AS drinks,
               COALESCE(c.paid_cash_cents, 0)  AS cash,
               COALESCE(c.paid_card_cents, 0)  AS card,
               COALESCE(c.paid_other_cents, 0) AS other,
               c.payment_method
          FROM dining_check c
          JOIN service_period p ON p.id = c.period_id
          LEFT JOIN head_charge h ON h.check_id = c.id
         WHERE p.business_date >= :d_from AND p.business_date <= :d_to
         GROUP BY c.id, p.business_date
    )
    SELECT business_date,
           -- merged 的单明细已搬到目标单，自己不计入任何统计；
           -- voided 单独统计，不进营业额
           COALESCE(SUM(subtotal + svc + tax) FILTER (WHERE status IN ('open','closed')), 0) AS revenue_cents,
           COALESCE(SUM(svc)            FILTER (WHERE status IN ('open','closed')), 0) AS service_cents,
           COALESCE(SUM(tax)            FILTER (WHERE status IN ('open','closed')), 0) AS tax_cents,
           COALESCE(SUM(guests)         FILTER (WHERE status IN ('open','closed')), 0) AS guests,
           COALESCE(SUM(drinks)         FILTER (WHERE status IN ('open','closed')), 0) AS drinks,
           COUNT(*)                     FILTER (WHERE status IN ('open','closed'))     AS check_count,
           COALESCE(SUM(cash)  FILTER (WHERE status = 'closed'), 0) AS cash_cents,
           COALESCE(SUM(card)  FILTER (WHERE status = 'closed'), 0) AS card_cents,
           COALESCE(SUM(other) FILTER (WHERE status = 'closed'), 0) AS other_cents,
           -- 已结但没记支付方式的单数：日结对账对不上时，先看这个数
           COUNT(*) FILTER (WHERE status = 'closed' AND payment_method IS NULL) AS unpaid_count,
           COUNT(*) FILTER (
               WHERE status = 'closed'
                 AND payment_method IS NOT NULL
                 AND cash + card + other <> subtotal + svc + tax
           ) AS mismatch_count,
           COALESCE(SUM(subtotal + svc + tax) FILTER (WHERE status = 'voided'), 0) AS voided_cents,
           COUNT(*)                     FILTER (WHERE status = 'voided')      AS voided_count
      FROM per_check
     GROUP BY business_date
     ORDER BY business_date
    """
)


@router.get("/daily", response_model=list[DayRow], dependencies=[_GUARD])
def daily(
    d_from: date = Query(alias="from"),
    d_to: date = Query(alias="to"),
    db: Session = Depends(get_db),
):
    rows = db.execute(_SQL, {"d_from": d_from, "d_to": d_to}).mappings().all()

    tips = {
        r.business_date: r
        for r in db.execute(
            text(
                """
                SELECT b.business_date,
                       COALESCE(b.tips_total_cents, 0) AS tips_total,
                       u.display_name                   AS by_name
                  FROM daily_batch b
                  LEFT JOIN app_user u ON u.id = b.tips_updated_by
                 WHERE b.business_date >= :d_from AND b.business_date <= :d_to
                """
            ),
            {"d_from": d_from, "d_to": d_to},
        ).all()
    }

    # 有小费但当天没有账单的情况也要显示 —— 比如系统上线前那几天，
    # 老板可能只补录了小费。漏掉它们会让月度小费合计对不上。
    dates = sorted({r["business_date"] for r in rows} | set(tips))
    by_date = {r["business_date"]: r for r in rows}

    out: list[DayRow] = []
    for d in dates:
        base = dict(by_date.get(d) or {})
        t = tips.get(d)
        out.append(
            DayRow(
                business_date=d,
                revenue_cents=base.get("revenue_cents", 0),
                service_cents=base.get("service_cents", 0),
                tax_cents=base.get("tax_cents", 0),
                guests=base.get("guests", 0),
                drinks=base.get("drinks", 0),
                check_count=base.get("check_count", 0),
                cash_cents=base.get("cash_cents", 0),
                card_cents=base.get("card_cents", 0),
                other_cents=base.get("other_cents", 0),
                unpaid_count=base.get("unpaid_count", 0),
                mismatch_count=base.get("mismatch_count", 0),
                voided_cents=base.get("voided_cents", 0),
                voided_count=base.get("voided_count", 0),
                tips_total_cents=t.tips_total if t else 0,
                tips_updated_by=t.by_name if t else None,
            )
        )
    return out


class TipsIn(BaseModel):
    business_date: date
    # 一天一个总数。不分现金/刷卡，也不按单记 ——
    # 店里收市时就是把卡机小费和桌上现金加一起报一个数。
    tips_total_cents: int = Field(ge=0)


@router.put("/tips", response_model=DayRow, dependencies=[_GUARD])
def set_tips(body: TipsIn, user: CurrentUser, db: Session = Depends(get_db)):
    """录入某一天的小费总额（一天一个数）。

    ⚠️ **这是唯一一个不走 /api/sync 的写入。** 理由：
      - 月报本来就是在线专用（权威数字只能服务端算），没有离线诉求
      - 小费不在营业流程的关键路径上，失败重试即可
      - 它写的是"日聚合"，而 sync 的本地镜像里根本没有日聚合这个概念

    这是一个**经过权衡的例外**，不是随手开的后门 ——
    任何会在离线时发生的写入，仍然必须走 sync。
    """
    row = db.scalar(
        select(DailyBatch).where(DailyBatch.business_date == body.business_date)
    )
    if row is None:
        row = DailyBatch(business_date=body.business_date)
        db.add(row)

    row.tips_total_cents = body.tips_total_cents
    # 小费直接影响员工分账，改动必须能追溯到人
    row.tips_updated_by = user.id
    row.tips_updated_at = datetime.now(timezone.utc)
    db.commit()

    return daily(d_from=body.business_date, d_to=body.business_date, db=db)[0]


class MonthRow(BaseModel):
    ym: str  # "2026-08"
    revenue_cents: int
    days: int
    tips_total_cents: int


@router.get("/months", response_model=list[MonthRow], dependencies=[_GUARD])
def months(db: Session = Depends(get_db)):
    """有数据的月份清单。

    给月份选择器用 —— 没数据的月份直接灰掉，省得一格格翻着找。
    同时把每月营业额一并带出来，选之前就能看到大概。
    """
    rows = db.execute(
        text(
            """
            WITH per_check AS (
                SELECT c.id, p.business_date, c.status,
                       COALESCE(SUM(h.qty * h.unit_price_cents), 0) AS subtotal,
                       c.service_charge_cents + c.tax_cents AS svc
                  FROM dining_check c
                  JOIN service_period p ON p.id = c.period_id
                  LEFT JOIN head_charge h ON h.check_id = c.id
                 GROUP BY c.id, p.business_date
            ),
            rev AS (
                SELECT to_char(business_date, 'YYYY-MM') AS ym,
                       SUM(subtotal + svc) FILTER (WHERE status IN ('open','closed')) AS revenue,
                       COUNT(DISTINCT business_date) FILTER (WHERE status IN ('open','closed')) AS days
                  FROM per_check GROUP BY 1
            ),
            tip AS (
                SELECT to_char(business_date, 'YYYY-MM') AS ym,
                       SUM(COALESCE(tips_total_cents, 0)) AS tips
                  FROM daily_batch GROUP BY 1
            )
            SELECT COALESCE(rev.ym, tip.ym)            AS ym,
                   COALESCE(rev.revenue, 0)::bigint    AS revenue_cents,
                   COALESCE(rev.days, 0)               AS days,
                   COALESCE(tip.tips, 0)::bigint       AS tips_total_cents
              FROM rev FULL OUTER JOIN tip ON tip.ym = rev.ym
             ORDER BY 1 DESC
            """
        )
    ).mappings().all()
    return [MonthRow(**dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# 税率设置
# ---------------------------------------------------------------------------


class TaxOut(BaseModel):
    rate: float
    effective_from: date
    note: str | None
    updated_by: str | None


class TaxIn(BaseModel):
    # 百分比，比如 7.1 表示 7.1%。用百分比而不是小数是因为
    # 人看到的、税务局公布的都是「7.1%」—— 让人去换算成 0.071 只会填错。
    rate_percent: float = Field(ge=0, lt=100)
    effective_from: date
    note: str | None = None


@router.get("/tax", response_model=TaxOut | None, dependencies=[_GUARD])
def get_tax(db: Session = Depends(get_db)):
    row = db.execute(
        text(
            """
            SELECT t.rate, t.effective_from, t.note, u.display_name AS updated_by
              FROM tax_rate t LEFT JOIN app_user u ON u.id = t.updated_by
             ORDER BY t.effective_from DESC LIMIT 1
            """
        )
    ).mappings().first()
    return TaxOut(**dict(row)) if row else None


@router.put("/tax", response_model=TaxOut, dependencies=[_GUARD])
def set_tax(body: TaxIn, user: CurrentUser, db: Session = Depends(get_db)):
    """设定税率。设一次基本不用再动。

    ⚠️ **同一个生效日只保留一条**（覆盖），不同生效日各留一行 ——
    今天设错了当天改掉是正常操作；但换了生效日就是一次真正的调率，
    历史账单必须还按旧税率算。
    """
    rate = round(body.rate_percent / 100, 5)
    row = db.scalar(
        select(TaxRate).where(TaxRate.effective_from == body.effective_from)
    )
    if row is None:
        row = TaxRate(effective_from=body.effective_from)
        db.add(row)
    row.rate = rate
    row.note = (body.note or None)
    row.updated_by = user.id
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return get_tax(db)


# ---------------------------------------------------------------------------
# 营业日设置：时区 + 日界
# ---------------------------------------------------------------------------

# 给设置页选的时区。不给全部 ~600 个 IANA 名字 ——
# 在 iPad 上翻六百行找不到自己那条，反而更容易选错。
# 店只可能在美国，列出这几个就够；真需要别的再加。
TZ_CHOICES: list[tuple[str, str]] = [
    ("America/Los_Angeles", "太平洋时间（加州 / 内华达 / 华盛顿州）"),
    ("America/Denver", "山地时间（科罗拉多 / 犹他）"),
    ("America/Phoenix", "亚利桑那（不实行夏令时）"),
    ("America/Chicago", "中部时间（德州 / 伊利诺伊）"),
    ("America/New_York", "东部时间（纽约 / 佛州）"),
    ("America/Anchorage", "阿拉斯加"),
    ("Pacific/Honolulu", "夏威夷（不实行夏令时）"),
]


class TzChoice(BaseModel):
    tz: str
    label: str


class BusinessDayOut(BaseModel):
    tz: str
    business_day_cutoff_hour: int
    updated_by: str | None
    # 按当前设置算出来的店内此刻时间和营业日。
    # 设置页把它显示出来 —— 时区选错了，这两个数一眼就不对，
    # 比任何校验都直观。
    store_now: datetime
    business_date: date
    choices: list[TzChoice]


class BusinessDayIn(BaseModel):
    tz: str
    business_day_cutoff_hour: int = Field(ge=0, le=23)


def _business_day_out(db: Session) -> BusinessDayOut:
    row = db.get(StoreSetting, 1)
    clock = load_store_clock(db)
    now_local = clock.now()
    updated_by = None
    if row is not None and row.updated_by is not None:
        updated_by = db.scalar(
            text("SELECT display_name FROM app_user WHERE id = :i"),
            {"i": row.updated_by},
        )
    return BusinessDayOut(
        tz=row.tz if row else str(clock.tz),
        business_day_cutoff_hour=clock.cutoff_hour,
        updated_by=updated_by,
        store_now=now_local,
        business_date=clock.business_date(now_local),
        choices=[TzChoice(tz=t, label=l) for t, l in TZ_CHOICES],
    )


@router.get("/business-day", response_model=BusinessDayOut, dependencies=[_GUARD])
def get_business_day(db: Session = Depends(get_db)):
    return _business_day_out(db)


@router.put("/business-day", response_model=BusinessDayOut, dependencies=[_GUARD])
def set_business_day(body: BusinessDayIn, user: CurrentUser, db: Session = Depends(get_db)):
    """设定店的时区与营业日分界。

    ⚠️ **没有生效日，改了就是全局改**，和税率相反。理由见 models.StoreSetting：
    税率是事实（历史账单必须冻住），时区是解释规则（设错了就该连
    过去的账一起重新归属，否则等于把错误永久冻在历史里）。

    直接后果：改时区会让月报里靠近日界的账单换一天。UI 上要说清楚。

    只接受 TZ_CHOICES 里的名字。不接受任意 IANA 名 ——
    这是个只有老板会点、一年点不到一次的设置，能选的越少越不会选错；
    真要加时区，改这里的常量比在生产上手输一个拼错的名字安全。
    """
    if body.tz not in {t for t, _ in TZ_CHOICES}:
        raise HTTPException(status_code=422, detail=f"不支持的时区：{body.tz}")

    row = db.get(StoreSetting, 1)
    if row is None:
        # 迁移已经插了这一行，正常到不了这里。留着是为了万一。
        row = StoreSetting(id=1)
        db.add(row)
    row.tz = body.tz
    row.business_day_cutoff_hour = body.business_day_cutoff_hour
    row.updated_by = user.id
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _business_day_out(db)
