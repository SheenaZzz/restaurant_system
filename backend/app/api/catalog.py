"""只读接口：菜单/价格/桌位目录 + 当前楼面状态。

写入一律走 /api/sync，这里只负责读。

目录一次性全给（20 桌 + 19 菜品 + 8 档价格，几 KB），
客户端缓存到 IndexedDB —— **离线时开桌页要能渲染出桌号和价格**。
分成三个端点只会多两次往返，没有任何好处。
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser
from ..db import get_db
from ..menu_data import CATEGORIES
from ..models import BuffetPrice, DiningTable, MenuItem
from ..services.period import period_kind_of, store_now

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


class CatalogOut(BaseModel):
    categories: list[CategoryOut]
    tables: list[TableOut]
    menu: list[MenuItemOut]
    prices: list[PriceOut]
    # 客户端拿它决定用午市还是晚市的价格来**显示**金额。
    # 落库时服务端会自己再算一遍，不信这个值。
    current_period_kind: str
    # 当前税率，供客户端**估算显示**用；落库金额一律服务端重算
    tax_rate: float
    server_time: datetime


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

    return CatalogOut(
        categories=[CategoryOut(key=k, label=v) for k, v in CATEGORIES],
        tables=[TableOut.model_validate(t, from_attributes=True) for t in tables],
        menu=[MenuItemOut.model_validate(m, from_attributes=True) for m in menu],
        prices=[PriceOut.model_validate(p, from_attributes=True) for p in prices],
        current_period_kind=period_kind_of(store_now()),
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
    """当前所有未结账单。

    只是**对账用的权威快照** —— 楼面界面平时读本地镜像，
    否则断网就白屏了。这个端点用来在重连后核对本地状态有没有漂移。
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
