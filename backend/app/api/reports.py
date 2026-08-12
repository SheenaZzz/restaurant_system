"""Reports, aggregated by business day.

**Authoritative numbers can only come from the server.** The amounts in a
client's local mirror are estimated from cached prices and only cover what
that device synced -- a month report built from them would be wrong. The cost
is that reports need a connection, but they are not the critical path (opening
and closing checks is, and that works offline).
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
    # Checks that recorded a payment whose amount does not match the check.
    # The usual cause: the check was edited after collecting and the payment was not.
    # When close of day does not reconcile, look here first.
    mismatch_count: int
    voided_cents: int
    voided_count: int
    # Tips are **not computed by the system** -- card machine tips and cash on
    # the table both happen outside it, so they can only be typed in. That
    # makes them a different kind of number from sales: sales is what should
    # have been taken, tips is what was actually received.
    tips_total_cents: int
    tips_updated_by: str | None


# Only managers and the owner see a whole month's sales -- a server has no
# reason to see the shop's figures. Not distrust, least privilege: the fewer
# people who can see it, the smaller the exposure.
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
           -- a merged check's lines have moved to its target, so it counts nowhere;
           -- voided is counted separately and never as sales
           COALESCE(SUM(subtotal + svc + tax) FILTER (WHERE status IN ('open','closed')), 0) AS revenue_cents,
           COALESCE(SUM(svc)            FILTER (WHERE status IN ('open','closed')), 0) AS service_cents,
           COALESCE(SUM(tax)            FILTER (WHERE status IN ('open','closed')), 0) AS tax_cents,
           COALESCE(SUM(guests)         FILTER (WHERE status IN ('open','closed')), 0) AS guests,
           COALESCE(SUM(drinks)         FILTER (WHERE status IN ('open','closed')), 0) AS drinks,
           COUNT(*)                     FILTER (WHERE status IN ('open','closed'))     AS check_count,
           COALESCE(SUM(cash)  FILTER (WHERE status = 'closed'), 0) AS cash_cents,
           COALESCE(SUM(card)  FILTER (WHERE status = 'closed'), 0) AS card_cents,
           COALESCE(SUM(other) FILTER (WHERE status = 'closed'), 0) AS other_cents,
           -- closed but with no payment method recorded: check this first when close of day does not reconcile
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

    # Days with tips but no checks still have to show up -- before the system
    # went live the owner may have back-filled tips only, and dropping those
    # would make the monthly tip total disagree.
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
    # One number for the day. Not split by cash/card, not per check --
    # at close the store adds the card machine's tips to the cash and reports one figure.
    tips_total_cents: int = Field(ge=0)


@router.put("/tips", response_model=DayRow, dependencies=[_GUARD])
def set_tips(body: TipsIn, user: CurrentUser, db: Session = Depends(get_db)):
    """Record one day's tip total (one number per day).

    ⚠️ **The only write that does not go through /api/sync.** Why:
      - reports are online-only anyway (authoritative numbers are server-side)
      - tips are off the critical path; a failure can just be retried
      - it writes a daily aggregate, and a local mirror has no such concept

    This is a **considered exception, not a back door** -- anything that can
    happen offline still has to go through sync.
    """
    row = db.scalar(
        select(DailyBatch).where(DailyBatch.business_date == body.business_date)
    )
    if row is None:
        row = DailyBatch(business_date=body.business_date)
        db.add(row)

    row.tips_total_cents = body.tips_total_cents
    # Tips feed staff payout directly, so a change has to be traceable to a person
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
    """The months that have data.

    For the month picker -- months with nothing are greyed out rather than
    paged through one by one. Sales come along for the ride, so the owner sees
    roughly what is there before picking.
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
# Tax rate settings
# ---------------------------------------------------------------------------


class TaxOut(BaseModel):
    rate: float
    effective_from: date
    note: str | None
    updated_by: str | None


class TaxIn(BaseModel):
    # A percentage, 7.1 meaning 7.1%. A percentage rather than a fraction
    # because 7.1% is what people and the county both say -- asking someone to
    # convert it to 0.071 only produces typos.
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
    """Set the tax rate. Set once, rarely touched.

    ⚠️ **One row per effective date** (overwritten), separate rows for
    different dates -- fixing a same-day typo is routine, but a new effective
    date is a real rate change and past checks have to keep the old rate.
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
# Drilling into a reconciliation warning: which checks, exactly
# ---------------------------------------------------------------------------

class DayCheckOut(BaseModel):
    check_uuid: str | None
    table_label: str | None
    source: str
    status: str
    opened_at: datetime
    closed_at: datetime | None
    total_cents: int
    paid_cents: int
    payment_method: str | None
    customer_name: str | None
    operator: str | None
    # voided only: the reason and who recorded it
    void_reason: str | None
    voided_by: str | None


# What one check owes and what was collected.
#
# ⚠️ These two expressions have to be **identical** to the ones _SQL uses for
#    mismatch_count above. Saying "3 checks do not match" and then listing 2
#    is worse than not offering the drill-down -- it makes every number
#    suspect. So both read the same definition.
_PER_CHECK = """
    SELECT c.id,
           c.client_uuid::text AS check_uuid,
           t.label             AS table_label,
           c.source, c.status, c.opened_at, c.closed_at,
           c.payment_method,
           -- the guest name lives on pickup_order, not on the check (PII: do not
           -- collect what you do not need; only to-go checks need a name to identify the guest)
           po.customer_name,
           u.display_name      AS operator,
             COALESCE((SELECT SUM(h.qty * h.unit_price_cents) FROM head_charge h
                        WHERE h.check_id = c.id), 0)
           + COALESCE((SELECT SUM(o.qty * o.unit_price_cents) FROM order_line o
                        WHERE o.check_id = c.id AND o.status <> 'voided'), 0)
           + c.service_charge_cents + c.tax_cents AS total_cents,
             COALESCE(c.paid_cash_cents, 0)
           + COALESCE(c.paid_card_cents, 0)
           + COALESCE(c.paid_other_cents, 0) AS paid_cents
      FROM dining_check c
      JOIN service_period p ON p.id = c.period_id
      LEFT JOIN dining_table t ON t.id = c.table_id
      LEFT JOIN app_user u ON u.id = c.opened_by
      LEFT JOIN pickup_order po ON po.check_id = c.id
     WHERE p.business_date = :d
"""

_KIND_WHERE = {
    # Voided: the amount itself is not sales, but "how much got voided" is exactly what the owner wants
    "voided": "status = 'voided'",
    # Closed with no payment method -- missed at close
    "unpaid": "status = 'closed' AND payment_method IS NULL",
    # Method recorded but the amount disagrees -- usually the check was edited after collecting
    "mismatch": (
        "status = 'closed' AND payment_method IS NOT NULL"
        " AND paid_cents <> total_cents"
    ),
}


@router.get("/day-checks", response_model=list[DayCheckOut], dependencies=[_GUARD])
def day_checks(
    d: date = Query(alias="date"),
    kind: str = Query(),
    db: Session = Depends(get_db),
):
    """Which checks are behind one reconciliation warning on a business day.

    A count of "3" on the month report is not something a person can act on --
    fixing it needs to know which three and by how much.
    """
    where = _KIND_WHERE.get(kind)
    if where is None:
        raise HTTPException(
            status_code=422, detail=f"Unknown kind: {kind} (voided/unpaid/mismatch)"
        )

    rows = db.execute(
        text(
            f"WITH per_check AS ({_PER_CHECK})"
            f" SELECT * FROM per_check WHERE {where} ORDER BY opened_at"
        ),
        {"d": d},
    ).mappings().all()

    # The void reason is in check_exception, and **undone voids do not count**
    # -- undo records are never deleted, so filter on reverted_at IS NULL
    reasons: dict[int, tuple[str | None, str | None]] = {}
    if kind == "voided" and rows:
        for r in db.execute(
            text(
                """
                SELECT e.check_id, e.reason, u.display_name AS by
                  FROM check_exception e
                  LEFT JOIN app_user u ON u.id = e.recorded_by
                 WHERE e.kind = 'void' AND e.reverted_at IS NULL
                   AND e.check_id = ANY(:ids)
                """
            ),
            {"ids": [r["id"] for r in rows]},
        ).mappings():
            reasons[r["check_id"]] = (r["reason"], r["by"])

    out = []
    for r in rows:
        reason, by = reasons.get(r["id"], (None, None))
        out.append(
            DayCheckOut(
                check_uuid=r["check_uuid"],
                table_label=r["table_label"],
                source=r["source"],
                status=r["status"],
                opened_at=r["opened_at"],
                closed_at=r["closed_at"],
                total_cents=int(r["total_cents"]),
                paid_cents=int(r["paid_cents"]),
                payment_method=r["payment_method"],
                customer_name=r["customer_name"],
                operator=r["operator"],
                void_reason=reason,
                voided_by=by,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Business-day settings: time zone and the day boundary
# ---------------------------------------------------------------------------

# The time zones offered in settings. Not all ~600 IANA names -- scrolling
# through six hundred rows on an iPad to find yours makes a wrong pick more
# likely, not less. The store can only be in the US; add more if that changes.
TZ_CHOICES: list[tuple[str, str]] = [
    ("America/Los_Angeles", "Pacific (CA / NV / WA)"),
    ("America/Denver", "Mountain (CO / UT)"),
    ("America/Phoenix", "Arizona (no DST)"),
    ("America/Chicago", "Central (TX / IL)"),
    ("America/New_York", "Eastern (NY / FL)"),
    ("America/Anchorage", "Alaska"),
    ("Pacific/Honolulu", "Hawaii (no DST)"),
]


class TzChoice(BaseModel):
    tz: str
    # English; the front-end catalogue localises it.
    label: str


class BusinessDayOut(BaseModel):
    tz: str
    business_day_cutoff_hour: int
    updated_by: str | None
    # The store's current time and business day under these settings.
    # Settings shows them, so a wrong time zone is obvious at a glance --
    # more use than any validation.
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
        choices=[TzChoice(tz=t, label=label) for t, label in TZ_CHOICES],
    )


@router.get("/business-day", response_model=BusinessDayOut, dependencies=[_GUARD])
def get_business_day(db: Session = Depends(get_db)):
    return _business_day_out(db)


@router.put("/business-day", response_model=BusinessDayOut, dependencies=[_GUARD])
def set_business_day(body: BusinessDayIn, user: CurrentUser, db: Session = Depends(get_db)):
    """Set the store's time zone and business-day boundary.

    ⚠️ **No effective date; a change applies to everything**, the opposite of
    the tax rate. Reasoning in models.StoreSetting: a rate is a fact (past
    checks have to be frozen), a time zone is an interpretation rule (getting
    it wrong means re-filing the past, not freezing the mistake forever).

    The direct consequence: changing it moves checks near the boundary to a

    Only names from TZ_CHOICES are accepted, not arbitrary IANA names -- this
    is a setting only the owner touches, less than once a year, and fewer
    choices means fewer wrong ones. Adding a zone by editing this constant is
    safer than typing a misspelled name into production.
    """
    if body.tz not in {t for t, _ in TZ_CHOICES}:
        raise HTTPException(status_code=422, detail=f"Unsupported time zone: {body.tz}")

    row = db.get(StoreSetting, 1)
    if row is None:
        # The migration already inserted this row; getting here should be impossible. Kept just in case.
        row = StoreSetting(id=1)
        db.add(row)
    row.tz = body.tz
    row.business_day_cutoff_hour = body.business_day_cutoff_hour
    row.updated_by = user.id
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _business_day_out(db)
