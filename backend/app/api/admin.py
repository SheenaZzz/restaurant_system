"""老板后台：改价（人头价、菜价、加料目录）和账户管理。

⚠️ **只给 admin**，比设置页（front_manager + admin）严。
   DESIGN.md 的权限矩阵里「改菜单/价格」这一行只有老板打勾 ——
   改价是能让每一单的钱都变的操作，和录小费、设税率不是一个量级。

账户管理同理，而且更严格：改密码是安全操作，**只能在线做** ——
离线排队一条"改密码"意味着它在某个不确定的时刻才生效，
而人事变动恰恰是要立刻生效的那种事。

写入不走 /api/sync：这些都是**在线专用的后台操作**，不在营业关键路径上，
和 PUT /api/reports/tax、/tips 同一类例外。离线时会发生的写入仍然必须走 sync。
"""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..core.deps import require_role
from ..core.security import hash_password
from ..db import get_db
from ..menu_data import CATEGORIES
from ..models import AppUser, AuthSession, BuffetPrice, MenuItem, MenuModifier
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


# ---------------------------------------------------------------------------
# 账户
#
# ⚠️ **密码只能重设，不能查看。** 库里存的是 argon2 哈希，设计上就是不可逆的 ——
#    这不是功能缺失。真能查出来就意味着拖库的人也查得出来。
#    老板忘了员工的密码，正确的做法是设一个新的，不是"找回"。
# ---------------------------------------------------------------------------

_ROLE_LABELS: dict[str, tuple[str, str]] = {
    "admin": ("老板", "Owner"),
    "front_manager": ("前台主管", "Front manager"),
    "front_employee": ("前台员工", "Front staff"),
    "kitchen": ("后厨", "Kitchen"),
}


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    role: str
    role_label: str
    role_label_en: str
    active: bool
    # 这个账号现在有几台设备还登录着。改密码前老板该看见这个数 ——
    # 「还有 2 台设备登录着」和「一台都没有」是两个决定。
    sessions: int


class UsersOut(BaseModel):
    users: list[UserOut]


def _users(db: Session) -> UsersOut:
    now = datetime.now(timezone.utc)
    live = dict(
        db.execute(
            select(AuthSession.user_id, func.count())
            .where(AuthSession.revoked_at.is_(None), AuthSession.expires_at > now)
            .group_by(AuthSession.user_id)
        ).all()
    )
    rows = db.scalars(select(AppUser).order_by(AppUser.id)).all()
    return UsersOut(
        users=[
            UserOut(
                id=u.id,
                username=u.username,
                display_name=u.display_name,
                role=u.role,
                role_label=_ROLE_LABELS.get(u.role, (u.role, u.role))[0],
                role_label_en=_ROLE_LABELS.get(u.role, (u.role, u.role))[1],
                active=u.active,
                sessions=live.get(u.id, 0),
            )
            for u in rows
        ]
    )


@router.get("/users", response_model=UsersOut, dependencies=[_ADMIN])
def get_users(db: Session = Depends(get_db)):
    return _users(db)


class UserPatch(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    display_name: str = Field(min_length=1, max_length=64)


@router.put("/users/{uid}", response_model=UsersOut, dependencies=[_ADMIN])
def set_user(uid: int, body: UserPatch, db: Session = Depends(get_db)):
    """改登录名和显示名。角色不在这里改 —— 见下面的说明。"""
    u = db.get(AppUser, uid)
    if u is None:
        raise HTTPException(404, "账号不存在")

    username = body.username.strip()
    display = body.display_name.strip()
    if not username or " " in username:
        raise HTTPException(422, "登录名不能为空、也不能有空格")

    # 登录是精确匹配（见 core/deps.user_by_username），所以 Admin 和 admin
    # 是两个账号。这对店里只会造成"我明明输对了却登不进去"，
    # 一律按小写存，把这个坑堵死。
    username = username.lower()

    if username != u.username:
        taken = db.scalar(select(AppUser).where(AppUser.username == username))
        if taken is not None:
            raise HTTPException(409, f"登录名已被占用：{username}")

    u.username = username
    u.display_name = display
    db.commit()
    return _users(db)


class PasswordIn(BaseModel):
    # 下限只有 4 位。这台服务器只在店内局域网上，威胁模型是
    # "员工离职后还能用自己的账号进来"，不是互联网上的暴力破解。
    # 强制复杂密码的真实后果是被写在收银台的便利贴上 —— 那更糟。
    password: str = Field(min_length=4, max_length=128)


@router.post("/users/{uid}/password", response_model=UsersOut, dependencies=[_ADMIN])
def set_password(uid: int, body: PasswordIn, db: Session = Depends(get_db)):
    """重设密码，并把这个账号已有的登录**全部吊销**。

    吊销是重点，不是附赠：老板改密码的典型场景就是员工离职，
    而那台 iPad 上的 refresh token 能一直续到 30 天后。
    不吊销的话，改完密码那个人照样进得来 —— 等于什么都没做。

    ⚠️ 已经发出去的 access token 撤不回来（JWT 不落库，这是它快的原因），
       所以最长还有 15 分钟的窗口。这是刻意的取舍，不是漏洞：
       要立刻断掉，就得每个请求都查库。
    """
    u = db.get(AppUser, uid)
    if u is None:
        raise HTTPException(404, "账号不存在")

    u.password_hash = hash_password(body.password)

    now = datetime.now(timezone.utc)
    for s in db.scalars(
        select(AuthSession).where(
            AuthSession.user_id == uid, AuthSession.revoked_at.is_(None)
        )
    ):
        s.revoked_at = now

    db.commit()
    return _users(db)
