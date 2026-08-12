"""Owner's back office: prices (per-head, dishes, add-ons) and accounts.

⚠️ **admin only**, stricter than the settings sheet (front_manager + admin).
   In DESIGN.md's permission matrix, "edit menu / prices" is ticked for the
   owner alone -- a price change moves the money on every check, which is

Accounts are the same, and stricter still: changing a password is a security
operation and **only works online**. Queuing one offline means it takes
effect at some unknown later moment, and a staffing change is exactly the

These writes do not go through /api/sync: they are **online-only back office**
work, off the critical path, the same class of exception as PUT
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
from ..services.buffet import BuffetError, load_board, set_board
from ..services.period import load_store_clock

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Owner only. Do not widen this to front_manager -- see the module docstring.
_ADMIN = Depends(require_role("admin"))


# ---------------------------------------------------------------------------
# Read: everything in one call
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
    # English name of the category, for the language switch
    label_en: str


class PricingOut(BaseModel):
    # Per-head prices in force (only the current row per combination)
    buffet: list[BuffetPriceOut]
    # Which day this version took effect -- shown in the UI, or the owner cannot tell which version is being edited
    buffet_effective_from: date | None
    menu: list[MenuItemOut]
    modifiers: list[ModifierOut]
    categories: list[CategoryOut]
    # Default effective date = today's business day, not the device date and not the UTC date
    business_date: date


@router.get("/pricing", response_model=PricingOut, dependencies=[_ADMIN])
def get_pricing(db: Session = Depends(get_db)):
    clock = load_store_clock(db)
    today = clock.business_date(clock.now())

    # For each (period, kind, guest type) take the newest row with
    # effective_from <= today. Same resolution as services/pricing.py -- what
    # the screen shows has to be **the version actually in use**, or the owner
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
# Write: per-head prices
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
    """Change the per-head prices.

    ⚠️ **The same effective date overwrites; a new one adds a version** -- same rule as the tax rate.

    A new effective date is a real price change, and the old prices have to
    stay: checks store a price snapshot, but recomputing the month report,
    reconciling, and answering "what did a seat cost then" all read this
    """
    for r in body.rows:
        if r.period_kind not in ("lunch", "dinner"):
            raise HTTPException(422, f"Bad period: {r.period_kind}")
        if r.charge_kind not in ("admission", "drink"):
            raise HTTPException(422, f"Bad charge kind: {r.charge_kind}")
        if r.guest_type not in ("adult", "child", "senior"):
            raise HTTPException(422, f"Bad guest type: {r.guest_type}")
        # ck_bp_drink_tier would catch this; say it in words first
        if r.charge_kind == "drink" and r.guest_type == "senior":
            raise HTTPException(422, "Drinks have adult and child tiers only; seniors pay the adult price")

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
# Write: dish prices
# ---------------------------------------------------------------------------

class MenuItemIn(BaseModel):
    id: int
    price_cents: int | None = Field(default=None, ge=0)
    active: bool


class MenuItemsIn(BaseModel):
    items: list[MenuItemIn]


@router.put("/menu-items", response_model=PricingOut, dependencies=[_ADMIN])
def set_menu_items(body: MenuItemsIn, db: Session = Depends(get_db)):
    """Change dish prices and what is on the menu.

    This one edits **in place**, with no effective date -- unlike per-head
    prices, because an order_line stores a unit_price_cents snapshot, so
    changing the menu cannot move a check that is already open. The per-head
    """
    for it in body.items:
        mi = db.get(MenuItem, it.id)
        if mi is None:
            raise HTTPException(422, f"No such dish: {it.id}")
        # Open-price items (Buffet To Go, by weight) have no fixed price -- do not pin one on
        if not mi.open_price:
            mi.price_cents = it.price_cents
        mi.active = it.active

    db.commit()
    return get_pricing(db)


# ---------------------------------------------------------------------------
# Write: the add-on catalogue (contents and order)
# ---------------------------------------------------------------------------

class ModifierIn(BaseModel):
    # no id = a new one
    id: int | None = None
    name_zh: str
    name_en: str = ""
    price_cents: int = Field(ge=0)


class ModifiersIn(BaseModel):
    """**The whole list arrives in order**; the array index is the display order."""

    rows: list[ModifierIn]


@router.put("/modifiers", response_model=PricingOut, dependencies=[_ADMIN])
def set_modifiers(body: ModifiersIn, db: Session = Depends(get_db)):
    """Change the contents and the order of the add-on catalogue.

    Wholesale replacement: rows with an id are edited, rows without are added,

    ⚠️ Deactivated, not deleted. order_line_modifier.modifier_id is a foreign
       key into this table, and deleting would orphan the add-ons on past
       checks. Deactivating changes nothing for them -- their label and
    """
    # ⚠️ Track **objects**, not ids: a new row has no id until flush, so an id
    #    set would make the deactivation loop below treat it as "not in the
    kept: list[MenuModifier] = []

    for i, r in enumerate(body.rows):
        name = r.name_zh.strip()
        if not name:
            raise HTTPException(422, "An add-on needs a name")

        if r.id is None:
            row = MenuModifier(name_zh=name, name_en=r.name_en.strip() or name)
            db.add(row)
        else:
            row = db.get(MenuModifier, r.id)
            if row is None:
                raise HTTPException(422, f"No such add-on: {r.id}")
            row.name_zh = name
            row.name_en = r.name_en.strip() or name

        row.price_cents = r.price_cents
        # The order is the array index. Leave gaps so inserting one by hand later needs no renumbering.
        row.sort_order = (i + 1) * 10
        row.active = True
        kept.append(row)

    db.flush()
    keep_ids = {r.id for r in kept}
    # Not in the list = the owner removed it -> deactivate (never delete, see above)
    for row in db.scalars(select(MenuModifier).where(MenuModifier.active.is_(True))):
        if row.id not in keep_ids:
            row.active = False

    db.commit()
    return get_pricing(db)


# ---------------------------------------------------------------------------
# Accounts
#
# ⚠️ **A password can be reset, never read.** What is stored is an argon2
#    hash, irreversible by design -- that is not a missing feature. Being able
#    to read one back would mean whoever dumps the database can too. When the
# ---------------------------------------------------------------------------

# Shown as-is on an English screen; the front-end catalogue turns them into
# Chinese. One place holds Chinese UI copy, and it is not this one.
_ROLE_LABELS: dict[str, str] = {
    "admin": "Owner",
    "front_manager": "Front manager",
    "front_employee": "Front staff",
    "kitchen": "Kitchen",
}


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str
    role: str
    role_label: str
    active: bool
    # How many devices are still signed in as this account. The owner should
    # see it before changing a password -- "two devices" and "none" are different decisions.
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
                role_label=_ROLE_LABELS.get(u.role, u.role),
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
    """Change the username and display name. Roles are not changed here -- see below."""
    u = db.get(AppUser, uid)
    if u is None:
        raise HTTPException(404, "No such account")

    username = body.username.strip()
    display = body.display_name.strip()
    if not username or " " in username:
        raise HTTPException(422, "A username cannot be empty or contain spaces")

    # Sign-in is an exact match (see core/deps.user_by_username), so Admin and
    # admin are two accounts. In a store that only produces "I typed it right
    # and it will not let me in", so everything is stored lower-cased.
    username = username.lower()

    if username != u.username:
        taken = db.scalar(select(AppUser).where(AppUser.username == username))
        if taken is not None:
            raise HTTPException(409, f"Username already taken: {username}")

    u.username = username
    u.display_name = display
    db.commit()
    return _users(db)


class PasswordIn(BaseModel):
    # Four characters is the floor. This server only lives on the store LAN;
    # the threat is "someone who left can still sign in", not brute force from
    # the internet. Forcing complex passwords really produces a sticky note on the till.
    password: str = Field(min_length=4, max_length=128)


@router.post("/users/{uid}/password", response_model=UsersOut, dependencies=[_ADMIN])
def set_password(uid: int, body: PasswordIn, db: Session = Depends(get_db)):
    """Reset a password and **revoke every session** that account holds.

    The revocation is the point, not a bonus: the reason an owner changes a
    staff password is that the person left, and the refresh token on their
    iPad would otherwise keep working for another 30 days. Without revoking,

    ⚠️ Access tokens already issued cannot be recalled (JWTs are not stored,
       which is why they are fast), so there is a window of up to 15 minutes.
       That is a deliberate trade: cutting it to zero means a database lookup on every request.
    """
    u = db.get(AppUser, uid)
    if u is None:
        raise HTTPException(404, "No such account")

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


# ---------------------------------------------------------------------------
# Write: the buffet layout
# ---------------------------------------------------------------------------

class BoardDishIn(BaseModel):
    # no id = a dish the owner just added
    id: int | None = None
    page: int = Field(ge=1, le=3)
    pos: int = Field(ge=1, le=10)
    name_zh: str
    name_en: str = ""


class BoardIn(BaseModel):
    """**One period's whole board arrives in order.** Lunch and dinner save separately."""

    period_kind: str
    rows: list[BoardDishIn]


class BoardOut(BaseModel):
    board: dict[str, list[dict]]


@router.get("/buffet-board", response_model=BoardOut, dependencies=[_ADMIN])
def get_buffet_board(db: Session = Depends(get_db)):
    return BoardOut(board=load_board(db))


@router.put("/buffet-board", response_model=BoardOut, dependencies=[_ADMIN])
def set_buffet_board(body: BoardIn, db: Session = Depends(get_db)):
    """Change the dishes on the buffet and where they sit.

    ⚠️ **Renaming in place keeps the dish and its history; a different dish
       means clearing the slot and adding one.** The UI says so too, because
       it decides whether the consumption model sees one continuous series or

    Removing deactivates rather than deletes: tray_event has a foreign key
    into this table, and deleting would orphan the refill history.
    """
    try:
        set_board(db, body.period_kind, [r.model_dump() for r in body.rows])
    except BuffetError as e:
        raise HTTPException(422, str(e)) from e
    db.commit()
    return BoardOut(board=load_board(db))
