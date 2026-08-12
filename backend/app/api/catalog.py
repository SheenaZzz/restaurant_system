"""Read-only endpoints: the menu, prices and table catalogue, plus floor state.

Every write goes through /api/sync; this only reads.

The catalogue arrives in one call (20 tables, 143 dishes, 8 prices -- a few
kB) and the client caches it in IndexedDB, because **opening a table has to
render seats and prices offline**. Splitting it into three endpoints would
only cost two more round trips.
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser
from ..db import get_db
from ..menu_data import CATEGORIES
from ..models import BuffetPrice, DiningTable, MenuItem, MenuModifier
from ..services.buffet import load_board
from ..services.period import load_store_clock

router = APIRouter(prefix="/api", tags=["catalog"])


class TableOut(BaseModel):
    label: str
    seats: int
    zone: str | None
    sort_order: int


class MenuItemOut(BaseModel):
    id: int
    name_en: str
    name_zh: str
    category: str
    price_cents: int | None
    is_buffet_dish: bool
    station: str
    sort_order: int
    open_price: bool


class PriceOut(BaseModel):
    period_kind: str
    charge_kind: str
    guest_type: str | None
    price_cents: int


class CategoryOut(BaseModel):
    key: str
    label: str
    # English name of the category, for the language switch
    label_en: str


class ModifierOut(BaseModel):
    id: int
    name_zh: str
    name_en: str
    price_cents: int
    sort_order: int


class BuffetDishOut(BaseModel):
    id: int
    page: int
    pos: int
    name_zh: str
    name_en: str


class CatalogOut(BaseModel):
    categories: list[CategoryOut]
    tables: list[TableOut]
    menu: list[MenuItemOut]
    # The add-on catalogue, sent with the menu -- ordering has to offer extra
    # spicy and add shrimp offline, and the client estimates prices from it
    # (the stored amount is still recomputed server-side from this same table).
    modifiers: list[ModifierOut]
    prices: list[PriceOut]
    # The buffet layout, grouped by period. Sent with the menu because the
    # refill page **has to work offline**: cooks keep refilling when the network
    # is down, which is exactly when a lost record hurts most.
    buffet_board: dict[str, list[BuffetDishOut]]
    # The client uses this to decide whether to **display** lunch or dinner
    # prices. The server recomputes on write and does not trust this value.
    current_period_kind: str
    # The current tax rate, for the client's **display estimate**; stored amounts are always recomputed
    tax_rate: float
    server_time: datetime
    # Where the business day starts (store local time, on the hour).
    #
    # Published rather than hard-coded in the front end: the business day is
    # defined in services/period.py and nowhere else. A second copy in the
    # front end means that the day someone moves the boundary back to 02:00,
    # the check list and the month report split it differently -- and those two
    # numbers agreeing is this system's only cross-check.
    business_day_cutoff_hour: int
    # The business day the server currently thinks it is. Offline the front end
    # computes its own from the device clock; online it can compare (in case
    # someone changed the iPad's time zone).
    business_date: date
    # The store's current UTC offset, **in minutes, east positive** (Pacific daylight = -420).
    #
    # The front end compares it with the device's own: a mismatch means this
    # device is not on store time, so every day there is a stretch where it
    # files checks on the wrong business day -- silently. Comparing business
    # days is not enough: while they agree the problem is invisible, and by the
    # time they disagree it has been wrong for hours.
    #
    # ⚠️ Mind the sign: JS getTimezoneOffset() is **inverted** (UTC-7 returns +420).
    #    This uses the conventional sign and the front end negates it, rather than both sides guessing.
    store_utc_offset_minutes: int


@router.get("/catalog", response_model=CatalogOut)
def catalog(user: CurrentUser, db: Session = Depends(get_db)):
    tables = db.scalars(
        select(DiningTable)
        .where(DiningTable.active.is_(True))
        .order_by(DiningTable.sort_order)
    ).all()
    menu = db.scalars(
        select(MenuItem).where(MenuItem.active.is_(True)).order_by(MenuItem.sort_order)
    ).all()
    prices = db.scalars(
        select(BuffetPrice).order_by(BuffetPrice.effective_from)
    ).all()
    modifiers = db.scalars(
        select(MenuModifier)
        .where(MenuModifier.active.is_(True))
        .order_by(MenuModifier.sort_order)
    ).all()

    # Take the clock once and derive every time-dependent field from it --
    # separate now() calls would give a self-contradictory answer to the request that straddles 00:00 or 15:00
    clock = load_store_clock(db)
    now_local = clock.now()

    return CatalogOut(
        categories=[
            CategoryOut(key=k, label=zh, label_en=en) for k, zh, en in CATEGORIES
        ],
        tables=[TableOut.model_validate(t, from_attributes=True) for t in tables],
        menu=[MenuItemOut.model_validate(m, from_attributes=True) for m in menu],
        modifiers=[
            ModifierOut.model_validate(m, from_attributes=True) for m in modifiers
        ],
        prices=[PriceOut.model_validate(p, from_attributes=True) for p in prices],
        buffet_board={
            k: [BuffetDishOut(**d) for d in v] for k, v in load_board(db).items()
        },
        current_period_kind=clock.period_kind(now_local),
        tax_rate=float(
            db.execute(
                text(
                    "SELECT rate FROM tax_rate WHERE effective_from <= CURRENT_DATE"
                    " ORDER BY effective_from DESC LIMIT 1"
                )
            ).scalar()
            or 0
        ),
        server_time=datetime.now(timezone.utc),
        business_day_cutoff_hour=clock.cutoff_hour,
        business_date=clock.business_date(now_local),
        store_utc_offset_minutes=int(
            (now_local.utcoffset().total_seconds() // 60) if now_local.utcoffset() else 0
        ),
    )


class OpenCheckOut(BaseModel):
    check_uuid: str
    table_label: str
    opened_at: datetime
    guests: int
    drinks: int
    subtotal_cents: int
    service_charge_cents: int
    tax_cents: int
    total_cents: int
    opened_by: str | None


@router.get("/floor", response_model=list[OpenCheckOut])
def floor(user: CurrentUser, db: Session = Depends(get_db)):
    """Every check that is currently open.

    Only an **authoritative snapshot for reconciliation** -- the floor screen
    reads its local mirror, or it would go blank offline. This endpoint is for
    checking after a reconnect whether the local state has drifted.
    """
    rows = db.execute(
        text(
            """
            SELECT c.client_uuid::text                            AS check_uuid,
                   t.label                                        AS table_label,
                   c.opened_at,
                   COALESCE(SUM(h.qty) FILTER (WHERE h.kind='admission'), 0) AS guests,
                   COALESCE(SUM(h.qty) FILTER (WHERE h.kind='drink'), 0)     AS drinks,
                   COALESCE(SUM(h.qty * h.unit_price_cents), 0)   AS subtotal_cents,
                   c.service_charge_cents,
                   c.tax_cents,
                   COALESCE(SUM(h.qty * h.unit_price_cents), 0)
                     + c.service_charge_cents + c.tax_cents        AS total_cents,
                   u.display_name                                 AS opened_by
              FROM dining_check c
              JOIN dining_table t ON t.id = c.table_id
              LEFT JOIN head_charge h ON h.check_id = c.id
              LEFT JOIN app_user u ON u.id = c.opened_by
             WHERE c.status = 'open' AND c.client_uuid IS NOT NULL
             GROUP BY c.client_uuid, t.label, c.opened_at, c.service_charge_cents,
                      c.tax_cents, u.display_name
             ORDER BY c.opened_at
            """
        )
    ).mappings().all()
    return [OpenCheckOut(**dict(r)) for r in rows]
