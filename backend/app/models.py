"""SQLAlchemy models -- the single source of truth for the schema.

Matches section 4 of DESIGN.md. Alembic autogenerates migrations from here.

Two names deviate from DESIGN.md, both to avoid SQL keywords or ambiguity:
  check   -> dining_check   (`check` is reserved; quoting it everywhere hurts)
  session -> auth_session   (`session` collides with SQLAlchemy's Session)
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PgUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


# timestamptz everywhere. Never a naive datetime -- the store spans lunch and
# dinner and observes DST, and a time zone ambiguity ruins the sales figures.
TZDateTime = DateTime(timezone=True)


# ---------------------------------------------------------------------------
# Menu and prices
# ---------------------------------------------------------------------------


class MenuItem(Base):
    __tablename__ = "menu_item"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name_en: Mapped[str] = mapped_column(Text, nullable=False)
    name_zh: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    # dishes on the buffet have no unit price
    price_cents: Mapped[int | None] = mapped_column(Integer)
    is_buffet_dish: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # 'wok' / 'fryer' / 'cold' / 'drink' / 'none'
    # 'none' and 'drink' never reach the kitchen queue -- this is the only test for "does it print a ticket"
    station: Mapped[str] = mapped_column(Text, nullable=False, default="none")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Open price: the front types the amount in; price_cents is ignored.
    # Buffet To Go is sold by weight -- the scale gives the amount, the system only records it.
    open_price: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        CheckConstraint(
            "station IN ('wok','fryer','cold','drink','none')", name="ck_menu_station"
        ),
        CheckConstraint(
            "price_cents IS NULL OR price_cents >= 0", name="ck_menu_price_nonneg"
        ),
        Index("ix_menu_item_active", "active", "category"),
    )


class ServicePeriod(Base):
    """One service period (a given day's lunch or dinner). Every check hangs off one."""

    __tablename__ = "service_period"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    opened_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (
        CheckConstraint("kind IN ('lunch','dinner')", name="ck_period_kind"),
        UniqueConstraint("business_date", "kind", name="uq_period_date_kind"),
    )


class BuffetPrice(Base):
    """Per-head prices. A price change is a new row with a new effective_from,
    **never an overwrite** -- overwriting would restate every past check."""

    __tablename__ = "buffet_price"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    period_kind: Mapped[str] = mapped_column(Text, nullable=False)
    charge_kind: Mapped[str] = mapped_column(Text, nullable=False)
    # Both kinds are tiered by guest_type.
    # Note that drink has adult / child only -- seniors pay the adult price,
    # which is what the store actually does, not a simplification.
    guest_type: Mapped[str] = mapped_column(Text, nullable=False)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)

    __table_args__ = (
        CheckConstraint("period_kind IN ('lunch','dinner')", name="ck_bp_period"),
        CheckConstraint("charge_kind IN ('admission','drink')", name="ck_bp_kind"),
        CheckConstraint(
            "guest_type IN ('adult','child','senior')", name="ck_bp_guest_type"
        ),
        # drinks have adult/child only; seniors pay the adult price
        CheckConstraint(
            "charge_kind <> 'drink' OR guest_type IN ('adult','child')",
            name="ck_bp_drink_tier",
        ),
        CheckConstraint("price_cents >= 0", name="ck_bp_price_nonneg"),
    )


# ---------------------------------------------------------------------------
# Tables and checks
# ---------------------------------------------------------------------------


class DiningTable(Base):
    __tablename__ = "dining_table"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    seats: Mapped[int] = mapped_column(Integer, nullable=False)
    zone: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class DiningCheck(Base):
    """One check. DESIGN.md calls it `check`; renamed here (SQL keyword).

    **The modelling point**: one check carries head_charge (per person) and
    order_line (per dish) at once -- a family on the buffet plus one seafood
    dish is exactly that shape.
    """

    __tablename__ = "dining_check"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Client-generated identity (the op_id of the op that created it).
    #
    # Why it exists: opening a check has to work offline, but the bigint
    # primary key comes from the database, which an offline client cannot
    # reach -- later ops (add dishes, collect) would have nothing to reference.
    # So the client mints a UUID for the outside world and the server's key
    # stays internal.
    client_uuid: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), unique=True
    )
    # pickup checks have no table
    table_id: Mapped[int | None] = mapped_column(ForeignKey("dining_table.id"))
    period_id: Mapped[int] = mapped_column(
        ForeignKey("service_period.id"), nullable=False
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    opened_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    opened_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))

    # A void is **reversible**, so it cannot reuse closed_at -- restoring a
    # check that went closed -> voided would otherwise lose the collect time.
    voided_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    # what it was before the void; undo puts it back
    pre_void_status: Mapped[str | None] = mapped_column(Text)

    # Merge: which check this one was folded into. Its lines have moved, and
    # it no longer counts toward sales.
    merged_into: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))

    # --- large-party service charge ---
    # Derived, but it **has to be stored**: the rate changes, and past checks
    # have to keep the rate they were charged. Recomputed whenever the party
    # size changes (open, edit, merge).
    service_charge_cents: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    # snapshot of the rate that applied, 0.100 = 10%
    service_charge_rate: Mapped[float | None] = mapped_column(Numeric(4, 3))

    # --- tax ---
    # Derived and stored for the same reason: the rate changes, past checks keep theirs.
    tax_cents: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    tax_rate: Mapped[float | None] = mapped_column(Numeric(6, 5))

    # --- payment method: **recorded only**, the system does not take money ---
    # Why record it: at close of day it is what the card machine and the drawer get reconciled against.
    payment_method: Mapped[str | None] = mapped_column(Text)
    paid_cash_cents: Mapped[int | None] = mapped_column(Integer)
    paid_card_cents: Mapped[int | None] = mapped_column(Integer)
    paid_other_cents: Mapped[int | None] = mapped_column(Integer)
    # a note for other, "gift card" for instance
    payment_note: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        # togo = buffet takeout, weighed and paid at the counter. No table, no
        # head count, just an amount (the scale already did the arithmetic).
        CheckConstraint(
            "source IN ('dine_in','pickup','togo')", name="ck_check_source"
        ),
        CheckConstraint(
            "status IN ('open','closed','voided','merged')", name="ck_check_status"
        ),
        CheckConstraint(
            "payment_method IS NULL"
            " OR payment_method IN ('cash','card','mixed','other')",
            name="ck_check_payment_method",
        ),
        # dine-in has to have a table; pickup and takeout never do
        CheckConstraint(
            "(source = 'dine_in' AND table_id IS NOT NULL)"
            " OR (source IN ('pickup','togo') AND table_id IS NULL)",
            name="ck_check_table_matches_source",
        ),
        Index("ix_check_period_status", "period_id", "status"),
        # **One table can hold only one open check.**
        # Two servers offline both think A7 is free and each open one -- on
        # reconnect the second hits this constraint, is rejected into the dead
        # letter queue and shows up red in the UI, for a person to decide
        # whether to merge or re-open. That conflict must not be swallowed.
        Index(
            "uq_check_open_per_table",
            "table_id",
            unique=True,
            postgresql_where="status = 'open' AND table_id IS NOT NULL",
        ),
    )


class HeadCharge(Base):
    """Per-head charges: buffet admission plus drinks (per person, free refills).

    Drinks are charged per person, so they are **not** an order_line -- like
    admission they are charged once per head, only with a different kind.
    """

    __tablename__ = "head_charge"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    check_id: Mapped[int] = mapped_column(
        ForeignKey("dining_check.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # Both kinds have to be tiered -- drinks too, since a child drink is priced separately
    guest_type: Mapped[str] = mapped_column(Text, nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price_cents: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        CheckConstraint("kind IN ('admission','drink')", name="ck_head_kind"),
        CheckConstraint(
            "guest_type IN ('adult','child','senior')", name="ck_head_guest_type"
        ),
        # drinks have adult/child only; seniors pay the adult price
        CheckConstraint(
            "kind <> 'drink' OR guest_type IN ('adult','child')",
            name="ck_head_drink_tier",
        ),
        CheckConstraint("qty > 0", name="ck_head_qty_pos"),
        CheckConstraint("unit_price_cents >= 0", name="ck_head_price_nonneg"),
        Index("ix_head_charge_check", "check_id"),
    )


class OrderLine(Base):
    """Per-dish charges: dine-in a la carte and pickup. Drinks never come here."""

    __tablename__ = "order_line"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    check_id: Mapped[int] = mapped_column(
        ForeignKey("dining_check.id", ondelete="CASCADE"), nullable=False
    )
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_item.id"), nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    # Price snapshot from when it was ordered -- joining menu_item for the
    # current price would restate every past check the moment the menu changes
    unit_price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="placed")
    placed_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    fired_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    ready_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (
        CheckConstraint(
            "status IN ('placed','fired','ready','served','voided')",
            name="ck_line_status",
        ),
        CheckConstraint("qty > 0", name="ck_line_qty_pos"),
        CheckConstraint("unit_price_cents >= 0", name="ck_line_price_nonneg"),
        Index("ix_order_line_check", "check_id"),
        # the kitchen queue's query path
        Index("ix_order_line_open", "status", "placed_at"),
    )


class PickupOrder(Base):
    """A phone pickup order.

    PII: **only the last four digits of the phone number**, enough to identify the guest.
    """

    __tablename__ = "pickup_order"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    check_id: Mapped[int] = mapped_column(
        ForeignKey("dining_check.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    customer_name: Mapped[str | None] = mapped_column(Text)
    phone_last4: Mapped[str | None] = mapped_column(String(4))
    # the time the guest said they would come
    promised_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    # actually arrived / actually picked up -- the gap between them is the
    # guest waiting, and promised vs arrived is how wrong the estimate was.
    # Both feed the timing work later on.
    arrived_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    picked_up_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="placed")

    __table_args__ = (
        CheckConstraint(
            "status IN ('placed','ready','picked_up','no_show','voided')",
            name="ck_pickup_status",
        ),
        CheckConstraint(
            "phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$'",
            name="ck_pickup_phone_last4",
        ),
    )


# ---------------------------------------------------------------------------
# Buffet refill events -- the only source for everything predicted later
# ---------------------------------------------------------------------------


class BuffetDish(Base):
    """One slot on the buffet.

    **Not the same thing as menu_item**, and they must not be merged:
    a menu_item can be ordered, has a price and goes on a check; a dish on the
    buffet is not charged for on its own -- it only has a position and a rate
    of consumption. And there are far more of them than the twelve menu rows
    flagged is_buffet_dish, with the owner changing them whenever.

    Position is part of the identity: one board for lunch and one for dinner,
    three pages of ten each. The same dish takes a row in each -- they are two
    different consumption processes (different crowd, length and refill pace)
    and belong apart.

    ⚠️ Renaming = the same dish written differently, history carries over.
       **Putting a different dish in a slot means deleting the row and adding
       one**, or the new dish inherits the old one's history. Deleting is
       deactivating (active=False) -- tray_event points at it.
    """

    __tablename__ = "buffet_dish"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    period_kind: Mapped[str] = mapped_column(Text, nullable=False)
    # Which page (1-3) and which slot on it (1-10). The order is the layout.
    page: Mapped[int] = mapped_column(Integer, nullable=False)
    pos: Mapped[int] = mapped_column(Integer, nullable=False)
    name_zh: Mapped[str] = mapped_column(Text, nullable=False)
    name_en: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (
        CheckConstraint("period_kind IN ('lunch','dinner')", name="ck_bd_period"),
        CheckConstraint("page BETWEEN 1 AND 3", name="ck_bd_page"),
        CheckConstraint("pos BETWEEN 1 AND 10", name="ck_bd_pos"),
        Index("ix_bd_layout", "period_kind", "page", "pos"),
    )


class TrayEvent(Base):
    """A refill / ran-empty event. Append-only.

    This table is the technical core of the project: buffet consumption is
    **not directly observable**. All there is are interval-censored events --
    filled at t1, found empty at t2 -- and "found empty" is itself late.
    The rate has to be inferred from those sparse events.

    ⚠️ `observed_at` is **when the client says it happened**, not when the
       server heard about it. Offline entry and late entry pull those far
       apart, and the model wants the former -- it sets the width of the
       censoring interval, so using the arrival time feeds error into the model.
    """

    __tablename__ = "tray_event"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    buffet_dish_id: Mapped[int] = mapped_column(
        ForeignKey("buffet_dish.id"), nullable=False
    )
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    # 0.0-1.0, recorded on refill / discard.
    # Always empty for now: the board has three buttons only. One more slider
    # and nobody taps anything at peak, and "no record" costs far more than
    # "a coarse record".
    fill_level: Mapped[float | None] = mapped_column(Numeric(3, 2))
    observed_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    recorded_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))

    __table_args__ = (
        CheckConstraint(
            "event_type IN ('refill','half','empty','discard')", name="ck_tray_type"
        ),
        CheckConstraint(
            "fill_level IS NULL OR (fill_level >= 0 AND fill_level <= 1)",
            name="ck_tray_fill_range",
        ),
        Index("ix_tray_dish_time", "buffet_dish_id", "observed_at"),
    )


# ---------------------------------------------------------------------------
# Exceptions and close of day
# ---------------------------------------------------------------------------


class CheckException(Base):
    """Walkout / comp / returned dish. **This is where money leaks, and the only path that needs internal control.**"""

    __tablename__ = "check_exception"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    check_id: Mapped[int] = mapped_column(ForeignKey("dining_check.id"), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    # Required, never blank -- a comp with no reason is no control at all
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    recorded_by: Mapped[int] = mapped_column(ForeignKey("app_user.id"), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    # over a threshold it needs an admin to sign off afterwards
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    approved_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    # Undo trace. **The original row is never deleted** -- "voided a $120
    # check and restored it ten minutes later" is itself something the owner
    # should see, and deleting the row deletes that signal.
    reverted_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    reverted_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    revert_reason: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint(
            "kind IN ('walkout','comp','discount','void','remake','other')",
            name="ck_exc_kind",
        ),
        CheckConstraint("length(btrim(reason)) > 0", name="ck_exc_reason_nonempty"),
        Index("ix_exception_time", "recorded_at"),
    )


class DailyBatch(Base):
    """Close of day. The point is not the sales total, it is **reconciliation**:
    what the system says is owed against what is actually in the card machine
    and the drawer.

    The system never touches payment, so every reported_* number is typed in
    by hand -- and that gap between computed and reported is the whole value.
    """

    __tablename__ = "daily_batch"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    business_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)

    # Computed by the system. **All nullable** -- they are a snapshot of the
    # moment the day was closed, and only mean anything then. Filling them in
    # before the day ends stores a number that goes stale the next check in.
    # Day-to-day queries always compute live (see reports.py).
    computed_admission_cents: Mapped[int | None] = mapped_column(Integer)
    computed_drink_cents: Mapped[int | None] = mapped_column(Integer)
    computed_item_cents: Mapped[int | None] = mapped_column(Integer)
    computed_total_cents: Mapped[int | None] = mapped_column(Integer)
    guest_adult: Mapped[int | None] = mapped_column(Integer)
    guest_child: Mapped[int | None] = mapped_column(Integer)
    guest_senior: Mapped[int | None] = mapped_column(Integer)
    check_count: Mapped[int | None] = mapped_column(Integer)
    exception_total_cents: Mapped[int | None] = mapped_column(Integer)

    # Typed in by hand, from the card machine and the drawer
    reported_card_cents: Mapped[int | None] = mapped_column(Integer)
    reported_cash_cents: Mapped[int | None] = mapped_column(Integer)

    # Tips: **one number for the day**, not split by cash/card and not per
    # check. What the store actually does at close is add the card machine's
    # tips to the cash on the tables and report one figure -- asking the
    # system for a finer split just means nobody enters anything.
    tips_total_cents: Mapped[int | None] = mapped_column(Integer)

    variance_cents: Mapped[int | None] = mapped_column(Integer)
    # Who last changed the tips -- it feeds staff payout, so it has to be traceable
    tips_updated_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    tips_updated_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    # Entry and approval are separate -- the most basic control there is
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    closed_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    approved_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    note: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------------------
# Accounts, devices, sessions
# ---------------------------------------------------------------------------


class AppUser(Base):
    __tablename__ = "app_user"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    username: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    # Hash of a 4-digit PIN, for switching accounts quickly on one device
    # (it attributes actions to a person; it is not a security boundary)
    pin_hash: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        # front is split in two:
        #   front_employee -- open and close checks (the daily work)
        #   front_manager  -- may also edit and void
        # Editing and voiding are the operations that **make money disappear**,
        # so they have to be authorised separately from the daily work.
        CheckConstraint(
            "role IN ('front_employee','front_manager','kitchen','admin')",
            name="ck_user_role",
        ),
    )


class Device(Base):
    """A device only carries a sync cursor and an audit trail. **It is not a principal** -- identity belongs to the account."""

    __tablename__ = "device"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    client_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    label: Mapped[str | None] = mapped_column(Text)
    first_seen: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, server_default=func.now()
    )
    last_seen: Mapped[datetime | None] = mapped_column(TZDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(TZDateTime)


class AuthSession(Base):
    __tablename__ = "auth_session"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("app_user.id"), nullable=False)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("device.id"))
    refresh_token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    issued_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (Index("ix_session_user_active", "user_id", "expires_at"),)


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


class SyncOp(Base):
    """The sync log. It carries the idempotency key and doubles as the full audit trail."""

    __tablename__ = "sync_op"

    op_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    # ⚠️ Identity() has to be explicit. SQLAlchemy's autoincrement=True only
    #    applies to a **primary key**; a non-key column gets no sequence and
    #    lands as a bare NOT NULL with no default, so inserts hit a
    #    NotNullViolation. The hand-written DDL used BIGSERIAL.
    seq: Mapped[int] = mapped_column(
        BigInteger, Identity(), nullable=False, unique=True
    )
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    entity: Mapped[str] = mapped_column(Text, nullable=False)
    op_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    client_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # Client clock: when it really happened offline (untrusted, for reference)
    client_ts: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    # Server clock: the authoritative ordering, and what conflicts resolve on
    received_at: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, server_default=func.now()
    )
    applied_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (
        Index(
            "ix_sync_op_applied_seq",
            "seq",
            postgresql_where="applied_at IS NOT NULL",
        ),
    )


class PingEvent(Base):
    """⚠️ Walking-skeleton probe table. Removed once Step 4 wired up real work."""

    __tablename__ = "ping_event"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Second line of defence: even if sync_op's idempotency check were
    # bypassed, this UNIQUE constraint still fails the duplicate write
    op_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("sync_op.op_id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)


class TaxRate(Base):
    """Sales tax rate.

    **A rate change is a new row with a new effective_from, never an**
    **overwrite** -- same reasoning as buffet_price: overwrite it and
    recomputing a past check would use the new rate, so old receipts and the
    books stop agreeing.

    Set once and rarely touched, but rates do change (state or county), so
    there has to be a way to change it.
    """

    __tablename__ = "tax_rate"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # 0.07100 = 7.1%
    rate: Mapped[float] = mapped_column(Numeric(6, 5), nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    updated_at: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("rate >= 0 AND rate < 1", name="ck_tax_rate_range"),
        UniqueConstraint("effective_from", name="uq_tax_rate_effective"),
    )


class MenuModifier(Base):
    """Catalogue of add-ons / special requests (extra spicy, add beef, add shrimp...).

    The price lives here and is **never taken from the client** -- same as
    dish prices: trusting a client-sent amount lets anyone discount themselves.
    The one exception is a request the front types in (some odd thing a guest
    asked for), where the amount can only be agreed and entered on the spot --
    the same class of exception as weighing Buffet To Go.
    """

    __tablename__ = "menu_modifier"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name_zh: Mapped[str] = mapped_column(Text, nullable=False)
    name_en: Mapped[str] = mapped_column(Text, nullable=False)
    # 0 = free (extra spicy, say). Charged **per portion** -- two dishes with shrimp is twice the money.
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (
        CheckConstraint("price_cents >= 0", name="ck_modifier_price_nonneg"),
    )


class OrderLineModifier(Base):
    """What was actually added to one dish.

    ⚠️ **The add-on money is already folded into order_line.unit_price_cents**;
       this table takes no part in the arithmetic. Why: every money
       calculation (total due, service charge base, tax base, month report) is
       SUM(qty x unit_price_cents), so folding it in means none of them change
       and none of them can be missed -- and a missed one is a hole that only

       shows up at reconciliation.
       What this table is for, then: (1) the check and the kitchen have to see
       what the guest actually asked for; (2) "how many guests add shrimp" is

       answerable later, which folding the price in would otherwise lose.
    label and price_cents are both **snapshots** -- same rule as dish prices
    and tax rates: changing the catalogue never changes a past check.
    """

    __tablename__ = "order_line_modifier"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    order_line_id: Mapped[int] = mapped_column(
        ForeignKey("order_line.id", ondelete="CASCADE"), nullable=False
    )
    # NULL = typed by the front, not in the catalogue
    modifier_id: Mapped[int | None] = mapped_column(ForeignKey("menu_modifier.id"))
    label: Mapped[str] = mapped_column(Text, nullable=False)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        CheckConstraint("price_cents >= 0", name="ck_line_modifier_price_nonneg"),
        Index("ix_line_modifier_line", "order_line_id"),
    )


class StoreSetting(Base):
    """The store's clock: its time zone and where its business day starts.

    **A single-row table** (id is always 1). The constraint is in the database
    rather than left to the application -- a second row would make "which time
    zone is the store in" a question with two answers.

    ⚠️ The opposite of TaxRate: **there is no effective_from here. A change is
       global.**

    That looks inconsistent, but they are different kinds of thing:
      - A tax rate or a dish price is a **fact** -- that day really was charged
        at 7.1%, so past checks have to be frozen, which needs effective dates
        and snapshots.
      - A time zone or a day boundary is an **interpretation rule** -- it
        answers "which day does this timestamp belong to". Once a rule turns
        out to be wrong (it used to be hard-coded UTC-5 while the store is on
        Pacific), the right move is to **re-file the past along with it**, not

        to freeze the mistake. An effective date would preserve the error
        forever and make it impossible to say which stretch was right.
    The cost: changing the time zone moves some checks to a different day in
    the month report. The UI has to say so.
    """

    __tablename__ = "store_setting"

    # autoincrement=False: this is a fixed 1, it does not want a sequence.
    # With one, a second INSERT would get id=2 and hit the CHECK, reported as
    # a constraint violation rather than "there should not be a second row".
    id: Mapped[int] = mapped_column(
        Integer, primary_key=True, autoincrement=False, default=1
    )
    # IANA time zone name, 'America/Los_Angeles' for instance.
    # Not a fixed offset -- an offset is wrong on the two DST changeover days.
    tz: Mapped[str] = mapped_column(Text, nullable=False)
    # Where the business day starts (store local time, on the hour). 0 = midnight.
    business_day_cutoff_hour: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    updated_at: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("id = 1", name="ck_store_setting_singleton"),
        CheckConstraint(
            "business_day_cutoff_hour >= 0 AND business_day_cutoff_hour < 24",
            name="ck_store_setting_cutoff_range",
        ),
    )
