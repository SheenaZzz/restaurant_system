"""老板改价：人头价、菜价、加料目录。

⚠️ **只给 admin**，比设置页（front_manager + admin）严。
   DESIGN.md 的权限矩阵里「改菜单/价格」这一行只有老板打勾 ——
   改价是能让每一单的钱都变的操作，和录小费、设税率不是一个量级。

写入不走 /api/sync：这三样都是**在线专用的后台操作**，不在营业关键路径上，
和 PUT /api/reports/tax、/tips 同一类例外。离线时会发生的写入仍然必须走 sync。
"""

from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.deps import require_role
from ..db import get_db
from ..menu_data import CATEGORIES
from ..models import BuffetPrice, MenuItem, MenuModifier
from ..services.period import load_store_clock

router = APIRouter(prefix="/api/admin", tags=["admin"])

# 老板专属。别放宽到 front_manager —— 见模块开头。
_ADMIN = Depends(require_role("admin"))


# ---------------------------------------------------------------------------
# 读：一次给全
# ---------------------------------------------------------------------------

class BuffetPriceOut(BaseModel):
    period_kind: str
    charge_kind: str
    guest_type: str
    price_cents: int
    effective_from: date


class MenuItemOut(BaseModel):
    id: int
    name_zh: str
    name_en: str
    category: str
    price_cents: int | None
    open_price: bool
    is_buffet_dish: bool
    active: bool
    sort_order: int


class ModifierOut(BaseModel):
    id: int
    name_zh: str
    name_en: str
    price_cents: int
    sort_order: int
    active: bool


class CategoryOut(BaseModel):
    key: str
    label: str
    # 分类的英文名，给中英切换用
    label_en: str


class PricingOut(BaseModel):
    # 当前生效的人头价（每个组合只给最新一条）
    buffet: list[BuffetPriceOut]
    # 这些价从哪天开始生效的 —— 界面上要显示，否则老板不知道自己在改哪一版
    buffet_effective_from: date | None
    menu: list[MenuItemOut]
    modifiers: list[ModifierOut]
    categories: list[CategoryOut]
    # 默认的生效日 = 今天的营业日，不是设备日期也不是 UTC 日期
    business_date: date


@router.get("/pricing", response_model=PricingOut, dependencies=[_ADMIN])
def get_pricing(db: Session = Depends(get_db)):
    clock = load_store_clock(db)
    today = clock.business_date(clock.now())

    # 每个 (时段, 类型, 客型) 组合取 effective_from <= 今天 里最新的一条。
    # 和 services/pricing.py 的解析口径一致 —— 界面上显示的必须是
    # **实际会被用到的那一版**，否则老板改的是一个自己看不见的值。
    rows = db.scalars(
        select(BuffetPrice)
        .where(BuffetPrice.effective_from <= today)
        .order_by(BuffetPrice.effective_from)
    ).all()
    current: dict[tuple[str, str, str], BuffetPrice] = {}
    for r in rows:
        current[(r.period_kind, r.charge_kind, r.guest_type)] = r

    buffet = sorted(
        current.values(),
        key=lambda r: (r.period_kind, r.charge_kind, r.guest_type),
    )

    menu = db.scalars(select(MenuItem).order_by(MenuItem.sort_order)).all()
    mods = db.scalars(select(MenuModifier).order_by(MenuModifier.sort_order)).all()

    return PricingOut(
        buffet=[BuffetPriceOut.model_validate(r, from_attributes=True) for r in buffet],
        buffet_effective_from=max((r.effective_from for r in buffet), default=None),
        menu=[MenuItemOut.model_validate(m, from_attributes=True) for m in menu],
        modifiers=[ModifierOut.model_validate(m, from_attributes=True) for m in mods],
        categories=[
            CategoryOut(key=k, label=zh, label_en=en) for k, zh, en in CATEGORIES
        ],
        business_date=today,
    )


# ---------------------------------------------------------------------------
# 写：人头价
# ---------------------------------------------------------------------------

class BuffetPriceIn(BaseModel):
    period_kind: str
    charge_kind: str
    guest_type: str
    price_cents: int = Field(ge=0)


class BuffetPricesIn(BaseModel):
    effective_from: date
    rows: list[BuffetPriceIn]


@router.put("/buffet-prices", response_model=PricingOut, dependencies=[_ADMIN])
def set_buffet_prices(body: BuffetPricesIn, db: Session = Depends(get_db)):
    """改人头价。

    ⚠️ **同一个生效日覆盖，换生效日新增** —— 和税率一个规矩。

    换生效日 = 一次真正的调价，旧价必须原样留着：历史账单虽然存了
    价格快照，但月报重算、对账、以及"当时到底卖多少钱"都要查这张表。
    同一生效日覆盖 = 今天设错了当天改回来，那不是调价。
    """
    for r in body.rows:
        if r.period_kind not in ("lunch", "dinner"):
            raise HTTPException(422, f"时段非法: {r.period_kind}")
        if r.charge_kind not in ("admission", "drink"):
            raise HTTPException(422, f"计费类型非法: {r.charge_kind}")
        if r.guest_type not in ("adult", "child", "senior"):
            raise HTTPException(422, f"客型非法: {r.guest_type}")
        # 数据库有 ck_bp_drink_tier 挡着，这里提前给一句人话
        if r.charge_kind == "drink" and r.guest_type == "senior":
            raise HTTPException(422, "饮料只有成人/儿童两档，长者按成人价")

    for r in body.rows:
        row = db.scalar(
            select(BuffetPrice).where(
                BuffetPrice.period_kind == r.period_kind,
                BuffetPrice.charge_kind == r.charge_kind,
                BuffetPrice.guest_type == r.guest_type,
                BuffetPrice.effective_from == body.effective_from,
            )
        )
        if row is None:
            row = BuffetPrice(
                period_kind=r.period_kind,
                charge_kind=r.charge_kind,
                guest_type=r.guest_type,
                effective_from=body.effective_from,
            )
            db.add(row)
        row.price_cents = r.price_cents

    db.commit()
    return get_pricing(db)


# ---------------------------------------------------------------------------
# 写：菜价
# ---------------------------------------------------------------------------

class MenuItemIn(BaseModel):
    id: int
    price_cents: int | None = Field(default=None, ge=0)
    active: bool


class MenuItemsIn(BaseModel):
    items: list[MenuItemIn]


@router.put("/menu-items", response_model=PricingOut, dependencies=[_ADMIN])
def set_menu_items(body: MenuItemsIn, db: Session = Depends(get_db)):
    """改菜价 / 上下架。

    这里是**直接改**，不留生效日 —— 和人头价不一样，因为
    order_line 落库时存的是 unit_price_cents 快照，改菜单价
    动不了任何一张已经开出去的单。人头价那张表是要被回查的，所以才要留版本。
    """
    for it in body.items:
        mi = db.get(MenuItem, it.id)
        if mi is None:
            raise HTTPException(422, f"菜品不存在: {it.id}")
        # 开放价条目（Buffet To Go 按重量称）没有固定价，别让它被设死
        if not mi.open_price:
            mi.price_cents = it.price_cents
        mi.active = it.active

    db.commit()
    return get_pricing(db)


# ---------------------------------------------------------------------------
# 写：加料目录（内容 + 顺序）
# ---------------------------------------------------------------------------

class ModifierIn(BaseModel):
    # 没有 id = 新增
    id: int | None = None
    name_zh: str
    name_en: str = ""
    price_cents: int = Field(ge=0)


class ModifiersIn(BaseModel):
    """**整份列表按顺序发上来**，数组下标就是显示顺序。"""

    rows: list[ModifierIn]


@router.put("/modifiers", response_model=PricingOut, dependencies=[_ADMIN])
def set_modifiers(body: ModifiersIn, db: Session = Depends(get_db)):
    """改加料目录的内容和顺序。

    整份替换：带 id 的原地改，没 id 的新增，**没出现在列表里的停用**。

    ⚠️ 停用而不是删除。order_line_modifier.modifier_id 是指向这张表的外键，
       删了会让历史账单的加料记录断链。停用对历史没有任何影响 ——
       那边的 label 和 price_cents 都是快照，不查这张表。
    """
    # ⚠️ 按**对象**跟踪，不能按 id：新增的行要 flush 之后才有 id，
    #    用 id 集合的话它们会被下面的停用循环当成"不在列表里"立刻停掉。
    kept: list[MenuModifier] = []

    for i, r in enumerate(body.rows):
        name = r.name_zh.strip()
        if not name:
            raise HTTPException(422, "加料名称不能为空")

        if r.id is None:
            row = MenuModifier(name_zh=name, name_en=r.name_en.strip() or name)
            db.add(row)
        else:
            row = db.get(MenuModifier, r.id)
            if row is None:
                raise HTTPException(422, f"加料不存在: {r.id}")
            row.name_zh = name
            row.name_en = r.name_en.strip() or name

        row.price_cents = r.price_cents
        # 顺序就是数组下标。留出间隔，将来手工插一条也不用整体重排。
        row.sort_order = (i + 1) * 10
        row.active = True
        kept.append(row)

    db.flush()
    keep_ids = {r.id for r in kept}
    # 列表里没有的 = 老板删掉了 → 停用（不删，见上面的说明）
    for row in db.scalars(select(MenuModifier).where(MenuModifier.active.is_(True))):
        if row.id not in keep_ids:
            row.active = False

    db.commit()
    return get_pricing(db)
