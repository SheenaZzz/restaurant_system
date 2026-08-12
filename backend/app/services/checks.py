"""Business side effects of opening and closing checks.

**Every write goes through sync. There is no second path.**
One write path means one set of invariants. If opening a check could go
through REST as well, the two sets of checks would drift, and the holes
that drift opens only turn up at reconciliation.
"""

import uuid as uuidlib
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from sqlalchemy import func

from ..models import (
    CheckException,
    DiningCheck,
    DiningTable,
    HeadCharge,
    MenuItem,
    MenuModifier,
    OrderLine,
    OrderLineModifier,
    PickupOrder,
    ServicePeriod,
    TaxRate,
)
from .period import resolve_period
from .pricing import resolve_head_prices

GUEST_TYPES = ("adult", "child", "senior")

# --- large-party service charge ---
# 10% at five guests or more.
# ⚠️ A constant for now. Once the rate really has to change it belongs in a
#    table with an effective_from, the way buffet_price does, or changing it
#    would alter what past checks recompute to. The service_charge_rate
#    snapshot on the check protects **existing** checks either way.
LARGE_PARTY_MIN = 5
SERVICE_CHARGE_RATE = Decimal("0.10")


def _party_size(db: Session, check_id: int) -> int:
    """Estimate how many people are at this table.

    We record how many people eat the buffet and how many drinks were
    ordered, never "how many people sat down". Someone who only drinks
    still takes a seat and still counts toward the party, so take the max:
      - 6 eating, 2 drinking -> at least 6
      - 3 eating, 5 drinking -> at least 5

    That is the best estimate this data supports. A stricter definition of
    "how many people" would need its own seat count, recorded at open time.
    """
    rows = db.execute(
        select(HeadCharge.kind, func.sum(HeadCharge.qty))
        .where(HeadCharge.check_id == check_id)
        .group_by(HeadCharge.kind)
    ).all()
    by_kind = {k: int(v or 0) for k, v in rows}
    return max(by_kind.get("admission", 0), by_kind.get("drink", 0))


def _current_tax_rate(db: Session, on: date) -> Decimal:
    """The tax rate in force on a business day. Never configured means 0."""
    r = db.scalar(
        select(TaxRate.rate)
        .where(TaxRate.effective_from <= on)
        .order_by(TaxRate.effective_from.desc())
        .limit(1)
    )
    return Decimal(str(r)) if r is not None else Decimal("0")


def _recalc_service_charge(db: Session, chk: DiningCheck) -> None:
    """Recompute the service charge **and the tax** for the current party.

    Merging is what trips it: two tables of three owe nothing, merged into
    six they do -- which is the whole reason this function exists.
    """
    db.flush()  # so the head_charge rows we just added are counted

    size = _party_size(db, chk.id)

    head = db.scalar(
        select(func.coalesce(func.sum(HeadCharge.qty * HeadCharge.unit_price_cents), 0))
        .where(HeadCharge.check_id == chk.id)
    ) or 0
    # A la carte lines count toward the base too (voided ones do not)
    lines = db.scalar(
        select(func.coalesce(func.sum(OrderLine.qty * OrderLine.unit_price_cents), 0))
        .where(OrderLine.check_id == chk.id, OrderLine.status != "voided")
    ) or 0
    subtotal = int(head + lines)

    # --- large-party service charge ---
    if size >= LARGE_PARTY_MIN:
        # Round to the cent with Decimal, not float -- money is never a float.
        chk.service_charge_cents = int(
            (Decimal(subtotal) * SERVICE_CHARGE_RATE).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP
            )
        )
        chk.service_charge_rate = SERVICE_CHARGE_RATE
    else:
        chk.service_charge_cents = 0
        chk.service_charge_rate = None

    # --- tax ---
    # Tax base = subtotal + service charge.
    # ⚠️ A mandatory service charge is taxable in most states (a voluntary
    #    tip is not). Ours is added automatically at five guests, so it is
    #    mandatory and belongs in the base. Different accounting, one line.
    period = db.get(ServicePeriod, chk.period_id)
    on = period.business_date if period else date.today()
    rate = _current_tax_rate(db, on)
    base = subtotal + chk.service_charge_cents
    chk.tax_cents = int(
        (Decimal(base) * rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    )
    chk.tax_rate = rate if rate > 0 else None
# Drinks have two tiers only -- seniors pay the adult price, which is what the store does
DRINK_TIERS = ("adult", "child")


def _parse_drinks(raw) -> dict[str, int]:
    """Parse the drink counts, **accepting the old payload shape as well**.

        new: {"adult": 2, "child": 1}
        old: 3            (same as {"adult": 3})

    ⚠️ Why the old shape has to keep working: this is offline-first. Some
    iPad's outbox may still hold ops queued before the upgrade, carrying the
    old shape. A server that rejects them sends real sales to the dead letter
    queue -- **a deploy that loses takings**. Changing a payload shape in an
    offline system requires a compatibility window; it is not optional.
    """
    if isinstance(raw, bool):
        raise BusinessError(f"Bad drink count: {raw!r}")

    if isinstance(raw, int):
        if raw < 0:
            raise BusinessError(f"Bad drink count: {raw!r}")
        return {"adult": raw} if raw else {}

    if isinstance(raw, dict):
        out: dict[str, int] = {}
        for tier in DRINK_TIERS:
            n = raw.get(tier, 0)
            if isinstance(n, bool) or not isinstance(n, int) or n < 0:
                raise BusinessError(f"Bad drink count: {tier}={n!r}")
            if n:
                out[tier] = n
        unknown = set(raw) - set(DRINK_TIERS)
        if unknown:
            # senior lands here -- say so instead of dropping it silently,
            # because dropping it silently means undercharging
            raise BusinessError(f"Unsupported drink tier: {sorted(unknown)} (adult/child only)")
        return out

    raise BusinessError(f"Bad drink count: {raw!r}")


class BusinessError(ValueError):
    """A business rule said no. sync turns it into a rejected op, which the
    client parks in its dead letter queue."""


def open_check(db: Session, op_id: uuidlib.UUID, payload: dict, client_ts: datetime,
               user_id: int | None) -> None:
    """Open a dine-in check: one dining_check plus its head_charge rows.

    payload = {
      "table_label": "A7",
      "guests": {"adult": 2, "child": 1, "senior": 0},
      "drinks": {"adult": 2, "child": 1}   # a bare integer also works
    }
    """
    label = payload.get("table_label")
    if not isinstance(label, str) or not label:
        raise BusinessError("table_label is missing")

    table = db.scalar(select(DiningTable).where(DiningTable.label == label))
    if table is None:
        raise BusinessError(f"No such table: {label}")

    guests_raw = payload.get("guests") or {}
    guests: dict[str, int] = {}
    for g in GUEST_TYPES:
        n = guests_raw.get(g, 0)
        if not isinstance(n, int) or n < 0:
            raise BusinessError(f"Bad guest count: {g}={n!r}")
        if n:
            guests[g] = n

    drinks = _parse_drinks(payload.get("drinks", 0))

    total_guests = sum(guests.values())
    total_drinks = sum(drinks.values())

    # ⚠️ Drinks **may exceed** the number of buffet guests -- somebody who
    #    tags along, does not eat and just wants a drink is common.
    #    (This used to reject drinks > guests, which read the rule too narrowly.)
    #
    #    One modelling consequence: the admission count is **how many people
    #    eat the buffet**, not how many sit at the table. That is exactly what
    #    consumption forecasting wants -- only eaters consume food -- but real
    #    occupancy would need a field of its own.
    lines = payload.get("lines") or []

    # A whole table ordering a la carte instead of the buffet is common, so any
    # one of the three is enough. All three empty is a check with nothing on it.
    if total_guests == 0 and total_drinks == 0 and not lines:
        raise BusinessError("Needs at least one guest, one drink, or one dish")

    # ⚠️ Use the op's client_ts rather than the server clock: a check queued
    # offline for two hours has to land in the period it **actually** happened in
    period = resolve_period(db, client_ts)
    prices = resolve_head_prices(db, period.kind, period.business_date)

    chk = DiningCheck(
        client_uuid=op_id,
        table_id=table.id,
        period_id=period.id,
        source="dine_in",
        status="open",
        opened_at=client_ts,
        opened_by=user_id,
    )
    db.add(chk)
    # flush so uq_check_open_per_table bites now -- if two servers opened the
    # same table offline, the second one has to blow up right here
    db.flush()

    for g, n in guests.items():
        price = prices.get(("admission", g))
        if price is None:
            raise BusinessError(f"No price configured for {period.kind}/{g}")
        db.add(
            HeadCharge(
                check_id=chk.id,
                kind="admission",
                guest_type=g,
                qty=n,
                unit_price_cents=price,
            )
        )

    for tier, n in drinks.items():
        price = prices.get(("drink", tier))
        if price is None:
            raise BusinessError(f"No drink price configured for {period.kind}/{tier}")
        db.add(
            HeadCharge(
                check_id=chk.id,
                kind="drink",
                guest_type=tier,
                qty=n,
                unit_price_cents=price,
            )
        )

    # Dishes ordered at open time (the whole-table-a-la-carte case)
    if lines:
        _add_lines(db, chk, lines, client_ts)

    _recalc_service_charge(db, chk)


def close_check(db: Session, payload: dict, client_ts: datetime) -> None:
    """Close the check. **Closing only -- the money is handled the way the store already does it.**"""
    raw = payload.get("check_uuid")
    try:
        cu = uuidlib.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        raise BusinessError(f"Bad check_uuid: {raw!r}") from None

    chk = db.scalar(select(DiningCheck).where(DiningCheck.client_uuid == cu))
    if chk is None:
        raise BusinessError("No such check (its open_check op may not have synced yet)")

    # Already closed counts as success -- idempotent. Two devices tapping
    # collect at the same time must not raise.
    if chk.status == "closed":
        return
    if chk.status == "voided":
        raise BusinessError("A voided check cannot be closed")

    chk.status = "closed"
    chk.closed_at = client_ts

    if "payment" in payload:
        _apply_payment(chk, payload.get("payment"))


def _load_check(db: Session, payload: dict) -> DiningCheck:
    raw = payload.get("check_uuid")
    try:
        cu = uuidlib.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        raise BusinessError(f"Bad check_uuid: {raw!r}") from None

    chk = db.scalar(select(DiningCheck).where(DiningCheck.client_uuid == cu))
    if chk is None:
        raise BusinessError("No such check (its open_check op may not have synced yet)")
    return chk


def modify_check(db: Session, payload: dict, client_ts: datetime) -> None:
    """Edit a check: replace the guest and drink counts wholesale.

    payload = {"check_uuid": ..., "guests": {...}, "drinks": {...}}

    **Replace rather than adjust.** An increment ("adult +1") goes wrong on
    offline replay: two devices each send +1 and it replays as +2, when what
    the operator meant was "there are three adults". Replacement is idempotent.

    Prices come from **the period this check belongs to**, not the current
    one -- editing a lunch check in the evening must not charge dinner prices.
    """
    chk = _load_check(db, payload)
    # Closed checks **can** be edited -- realising the guest count was wrong
    # after collecting is routine. Only voided is blocked: undo the void
    # first, or the meaning is murky (what does editing a voided check mean?).
    if chk.status == "voided":
        raise BusinessError("Undo the void before editing this check")

    guests: dict[str, int] = {}
    guests_raw = payload.get("guests") or {}
    for g in GUEST_TYPES:
        n = guests_raw.get(g, 0)
        if isinstance(n, bool) or not isinstance(n, int) or n < 0:
            raise BusinessError(f"Bad guest count: {g}={n!r}")
        if n:
            guests[g] = n

    drinks = _parse_drinks(payload.get("drinks", 0))
    if sum(guests.values()) == 0 and sum(drinks.values()) == 0:
        raise BusinessError("Needs at least one guest or one drink")

    period = db.get(ServicePeriod, chk.period_id)
    if period is None:
        raise BusinessError("This check has lost its service period")
    prices = resolve_head_prices(db, period.kind, period.business_date)

    # Delete then re-add. sync_op keeps the whole edit history, so the audit trail is intact.
    db.query(HeadCharge).filter(HeadCharge.check_id == chk.id).delete(
        synchronize_session=False
    )

    for g, n in guests.items():
        price = prices.get(("admission", g))
        if price is None:
            raise BusinessError(f"No price configured for {period.kind}/{g}")
        db.add(
            HeadCharge(
                check_id=chk.id, kind="admission", guest_type=g,
                qty=n, unit_price_cents=price,
            )
        )
    for tier, n in drinks.items():
        price = prices.get(("drink", tier))
        if price is None:
            raise BusinessError(f"No drink price configured for {period.kind}/{tier}")
        db.add(
            HeadCharge(
                check_id=chk.id, kind="drink", guest_type=tier,
                qty=n, unit_price_cents=price,
            )
        )

    _recalc_service_charge(db, chk)


def void_check(db: Session, payload: dict, client_ts: datetime,
               user_id: int | None) -> None:
    """Void a whole check, **with a mandatory reason**.

    Voiding is the only operation that makes a whole check's money vanish,
    so it has to:
      1. carry a reason (blank is rejected)
      2. be attributable to a person
      3. leave a row in the exception table, which the owner's report reads
    """
    chk = _load_check(db, payload)
    if chk.status == "voided":
        return  # idempotent

    reason = payload.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise BusinessError("A void has to have a reason")

    amount = _check_total_cents(db, chk)

    # Remember what it was before, so undo can put it back.
    # **Leave closed_at alone** -- that is when it was collected, a different fact.
    chk.pre_void_status = chk.status
    chk.status = "voided"
    chk.voided_at = client_ts

    db.add(
        CheckException(
            check_id=chk.id,
            kind="void",
            amount_cents=int(amount),
            reason=reason.strip(),
            recorded_by=user_id,
            recorded_at=client_ts,
        )
    )


def restore_check(db: Session, payload: dict, client_ts: datetime,
                  user_id: int | None) -> None:
    """Undo a void and put the check back the way it was.

    A void is reversible -- voiding the wrong check is a common slip, and
    without an undo the only fix is re-entering it, which loses the original
    open time and the original operator.

    **The void record is not deleted**, it only gets an "undone" stamp.
    "Voided a $120 check and restored it ten minutes later" is exactly the
    signal an owner should see; deleting the record deletes the signal.

    The reason is **optional** here -- the dangerous direction (voiding) has
    to justify itself, the corrective one should not have friction added.
    """
    chk = _load_check(db, payload)
    if chk.status != "voided":
        return  # idempotent: already in a normal state

    reason = payload.get("reason")
    reason = reason.strip() if isinstance(reason, str) and reason.strip() else None

    target = chk.pre_void_status or "open"

    # ⚠️ Real edge: once voided the table is free, and it has probably been
    #    opened again. Restoring would leave two open checks on one table
    #    and hit the unique index -- the database stops it, but as a
    #    UniqueViolation, which no manager can read. Check it here first.
    if target == "open" and chk.table_id is not None:
        conflict = db.scalar(
            select(DiningCheck.id).where(
                DiningCheck.table_id == chk.table_id,
                DiningCheck.status == "open",
                DiningCheck.id != chk.id,
            )
        )
        if conflict is not None:
            table = db.get(DiningTable, chk.table_id)
            raise BusinessError(
                f"{table.label if table else 'That table'} already has an open "
                "check, so this one cannot be restored. Close or void that one first."
            )

    chk.status = target
    chk.pre_void_status = None
    chk.voided_at = None

    # Stamp the most recent void record that has not been undone
    exc = db.scalars(
        select(CheckException)
        .where(
            CheckException.check_id == chk.id,
            CheckException.kind == "void",
            CheckException.reverted_at.is_(None),
        )
        .order_by(CheckException.recorded_at.desc())
        .limit(1)
    ).first()
    if exc is not None:
        exc.reverted_at = client_ts
        exc.reverted_by = user_id
        exc.revert_reason = reason


# ---------------------------------------------------------------------------
# Payment method (**recorded only** -- the system does not take money)
# ---------------------------------------------------------------------------

PAYMENT_METHODS = ("cash", "card", "mixed", "other")


def _check_total_cents(db: Session, chk: DiningCheck) -> int:
    """What this check owes right now (heads + dishes + service charge + tax).

    Computed every time instead of stored in a total column -- a stored total
    has to be kept in step after adding dishes, editing, merging and changing
    the tax rate, and one missed spot is an amount that disagrees with itself
    and only surfaces at reconciliation.
    """
    head = db.scalar(
        select(func.coalesce(func.sum(HeadCharge.qty * HeadCharge.unit_price_cents), 0))
        .where(HeadCharge.check_id == chk.id)
    ) or 0
    lines_amt = db.scalar(
        select(func.coalesce(func.sum(OrderLine.qty * OrderLine.unit_price_cents), 0))
        .where(OrderLine.check_id == chk.id, OrderLine.status != "voided")
    ) or 0
    return int(head) + int(lines_amt) + chk.service_charge_cents + chk.tax_cents


def _paid_cents(chk: DiningCheck) -> int:
    return (
        (chk.paid_cash_cents or 0)
        + (chk.paid_card_cents or 0)
        + (chk.paid_other_cents or 0)
    )


def _apply_payment(chk: DiningCheck, raw) -> None:
    """Record how a check was paid.

    Why bother: the system never touches money, so the **only** cross-check at
    close of day is "what the system says each method took" against "what is
    actually in the card machine and the drawer". Without the method, a $30
    gap cannot be pinned on cash or on card.
    """
    if raw is None:
        chk.payment_method = None
        chk.paid_cash_cents = chk.paid_card_cents = chk.paid_other_cents = None
        chk.payment_note = None
        return

    if not isinstance(raw, dict):
        raise BusinessError(f"Bad payment payload: {raw!r}")

    method = raw.get("method")
    if method not in PAYMENT_METHODS:
        raise BusinessError(f"Bad payment method: {method!r} (cash/card/mixed/other)")

    def amt(key: str) -> int:
        v = raw.get(key, 0)
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise BusinessError(f"Bad amount: {key}={v!r}")
        return v

    cash, card, other = amt("cash_cents"), amt("card_cents"), amt("other_cents")

    if method == "mixed" and sum(x > 0 for x in (cash, card, other)) < 2:
        raise BusinessError("Mixed was chosen but only one method has an amount")

    note = raw.get("note")
    note = note.strip() if isinstance(note, str) and note.strip() else None
    if method == "other" and not note:
        raise BusinessError("Other needs a note (a gift card, for instance)")

    chk.payment_method = method
    chk.paid_cash_cents = cash
    chk.paid_card_cents = card
    chk.paid_other_cents = other
    chk.payment_note = note


def set_payment(db: Session, payload: dict, client_ts: datetime) -> None:
    """Change the payment method after the fact.

    Open to regular staff rather than managers only -- recording the wrong
    method never makes money disappear, and needing a manager every time is
    enough friction that people stop recording it at all. Who changed it is
    in sync_op either way.
    """
    chk = _load_check(db, payload)
    if chk.status == "voided":
        raise BusinessError("A voided check's payment method cannot be changed")
    _apply_payment(chk, payload.get("payment"))


def add_payment(db: Session, payload: dict, client_ts: datetime) -> None:
    """Top up: **add to what was already collected**, never replace it.

    Why this cannot reuse set_payment: adding dishes after collecting happens
    all the time (the system deliberately allows editing a closed check). The
    check goes from $55.47 to $62.46 while the collected amount stays at
    $55.47 -- which is exactly what the month report's "payment does not
    match the check" warning catches. Putting the $6.99 through set_payment
    would **wipe out** the original $55.47 and make the mismatch worse.

    ⚠️ The addition has to happen on the server. The client says "this much
       was collected just now", never "this much in total" -- its copy of the
       collected amount may be stale (another device just topped up), and
       overwriting with a stale total is losing money.

    No payment_event table: every top-up is already a sync_op carrying its
    client_ts and its operator. "This one was collected in two goes" replays
    out of the operation history -- the data is in the audit log already.
    """
    chk = _load_check(db, payload)
    if chk.status == "voided":
        raise BusinessError("A voided check cannot be topped up")

    raw = payload.get("payment")
    if not isinstance(raw, dict):
        raise BusinessError(f"Bad payment payload: {raw!r}")

    def amt(key: str) -> int:
        v = raw.get(key, 0)
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise BusinessError(f"Bad amount: {key}={v!r}")
        return v

    add_cash, add_card, add_other = (
        amt("cash_cents"),
        amt("card_cents"),
        amt("other_cents"),
    )
    added = add_cash + add_card + add_other
    if added <= 0:
        raise BusinessError("The top-up has to be greater than 0")

    note = raw.get("note")
    note = note.strip() if isinstance(note, str) and note.strip() else None
    if add_other > 0 and not note:
        raise BusinessError("Other in a top-up needs a note (a gift card, for instance)")

    total = _check_total_cents(db, chk)
    due = total - _paid_cents(chk)
    if due <= 0:
        raise BusinessError("This check is fully paid; there is nothing to top up")
    if added > due:
        raise BusinessError(
            f"A top-up of {added / 100:.2f} is more than the {due / 100:.2f} "
            "outstanding. The excess does not belong on this check -- check the amount."
        )

    chk.paid_cash_cents = (chk.paid_cash_cents or 0) + add_cash
    chk.paid_card_cents = (chk.paid_card_cents or 0) + add_card
    chk.paid_other_cents = (chk.paid_other_cents or 0) + add_other

    # The method is **derived** from the three buckets; a client-supplied one
    # is ignored -- one card payment plus one cash payment is mixed, by definition.
    buckets = [chk.paid_cash_cents, chk.paid_card_cents, chk.paid_other_cents]
    nonzero = [i for i, v in enumerate(buckets) if v]
    if len(nonzero) > 1:
        chk.payment_method = "mixed"
    elif nonzero:
        chk.payment_method = ("cash", "card", "other")[nonzero[0]]

    if note:
        # A top-up note appends rather than overwrites -- the first note stays
        chk.payment_note = f"{chk.payment_note} / {note}" if chk.payment_note else note


# ---------------------------------------------------------------------------
# Transfer / merge
# ---------------------------------------------------------------------------


def transfer_check(db: Session, payload: dict, client_ts: datetime) -> None:
    """Move a check to another table mid-meal.

    Open to regular staff -- routine, and no money changes.
    """
    chk = _load_check(db, payload)
    if chk.status in ("voided", "merged"):
        raise BusinessError(f"A {chk.status} check cannot be transferred")

    label = payload.get("to_table_label")
    if not isinstance(label, str) or not label:
        raise BusinessError("The destination table is missing")

    target = db.scalar(select(DiningTable).where(DiningTable.label == label))
    if target is None:
        raise BusinessError(f"No such table: {label}")
    if target.id == chk.table_id:
        return  # idempotent: already there

    # Only open checks hold a table -- a closed one cannot conflict
    if chk.status == "open":
        busy = db.scalar(
            select(DiningCheck.id).where(
                DiningCheck.table_id == target.id,
                DiningCheck.status == "open",
                DiningCheck.id != chk.id,
            )
        )
        if busy is not None:
            raise BusinessError(f"{label} already has an open check (merge them instead?)")

    chk.table_id = target.id


def merge_checks(db: Session, payload: dict, client_ts: datetime) -> None:
    """Merge several checks into one.

    payload = {"check_uuid": target, "source_uuids": [checks to fold in...]}

    **The lines move to the target and the sources are marked merged.**
    Sales are then counted once. Keeping each source's lines and adding them
    up for display makes it far too easy to get the accounting wrong -- which
    ones count? After the move the sources are empty, merged, counted nowhere.

    ⚠️ **Un-merging is not supported.** Splitting means voiding and re-entering
    -- merging is rare enough in the store not to pay for the complexity.
    """
    target = _load_check(db, payload)
    if target.status not in ("open", "closed"):
        raise BusinessError(f"A {target.status} check cannot be a merge target")

    raw = payload.get("source_uuids")
    if not isinstance(raw, list) or not raw:
        raise BusinessError("Nothing to merge in")

    for item in raw:
        try:
            su = uuidlib.UUID(str(item))
        except (ValueError, TypeError):
            raise BusinessError(f"Bad source_uuid: {item!r}") from None
        if su == target.client_uuid:
            raise BusinessError("A check cannot be merged into itself")

        src = db.scalar(select(DiningCheck).where(DiningCheck.client_uuid == su))
        if src is None:
            raise BusinessError("The check to merge in does not exist (it may not have synced yet)")
        if src.status == "merged":
            continue  # idempotent
        if src.status not in ("open", "closed"):
            raise BusinessError(f"A {src.status} check cannot be merged")

        # Move the lines. Rows with the same kind+guest_type sit side by side
        # and are summed when counted rather than folded into one -- knowing
        # which table those guests came from is worth little, but the extra
        # rows at least show that a merge happened.
        db.query(HeadCharge).filter(HeadCharge.check_id == src.id).update(
            {"check_id": target.id}, synchronize_session=False
        )
        src.status = "merged"
        src.merged_into = target.client_uuid
        src.service_charge_cents = 0
        src.service_charge_rate = None

    # The party is bigger now -- two tables of three owed nothing, six owes
    # 10%. This is the consequence of merging that is easiest to forget.
    _recalc_service_charge(db, target)


# ---------------------------------------------------------------------------
# Buffet takeout (by weight)
# ---------------------------------------------------------------------------

TOGO_ITEM_EN = "Buffet To-Go (by weight)"


def togo_sale(db: Session, op_id: uuidlib.UUID, payload: dict,
              client_ts: datetime, user_id: int | None) -> None:
    """One buffet takeout sale.

    payload = {"amount_cents": 1875, "payment": {...}}

    Three ways it differs from dine-in:
      - **no table** -- a counter sale, no seat taken
      - **no head count** -- the scale gives the amount; how many people it feeds is unknown and does not matter
      - **no service charge** -- that is a large-party dine-in thing

    The amount lands on an order_line (qty=1, unit_price is what the scale
    said) rather than a head_charge -- head_charge means "per person", and a
    qty=1 row there would later be counted as one guest.

    **Created and closed in one step** -- takeout is paid at the counter, so
    an open takeout check does not exist. Two steps would only add another
    way for an offline replay to fail.
    """
    amount = payload.get("amount_cents")
    if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
        raise BusinessError(f"Bad amount: {amount!r}")

    item = db.scalar(select(MenuItem).where(MenuItem.name_en == TOGO_ITEM_EN))
    if item is None:
        raise BusinessError("The takeout item is not configured (run the seed first)")

    period = resolve_period(db, client_ts)

    chk = DiningCheck(
        client_uuid=op_id,
        table_id=None,
        period_id=period.id,
        source="togo",
        status="closed",          # paid at the counter, closed immediately
        opened_at=client_ts,
        closed_at=client_ts,
        opened_by=user_id,
    )
    db.add(chk)
    db.flush()

    db.add(
        OrderLine(
            check_id=chk.id,
            menu_item_id=item.id,
            qty=1,
            unit_price_cents=amount,
            status="served",      # takeout has no kitchen flow
            placed_at=client_ts,
            ready_at=client_ts,
        )
    )

    if "payment" in payload:
        _apply_payment(chk, payload.get("payment"))


# ---------------------------------------------------------------------------
# To go: buffet by weight, and phone orders
# ---------------------------------------------------------------------------


def _resolve_modifiers(
    db: Session, raw, dish: str
) -> list[tuple[int | None, str, int]]:
    """Resolve the add-ons on one dish into (modifier_id, label snapshot, price).

    Two sources, with very different authority over the price:

    - From the catalogue (carries modifier_id) -- **the server looks the price
      up**; whatever the client sent is ignored. Trusting the client's amount
      is letting anyone discount themselves.

    - Typed by the front (label + price_cents) -- an odd request from a guest,
      priced on the spot. Same class of exception as weighing buffet takeout:
      not laziness, the number **only exists at the counter**. Which is why it
      is attributed to a person (sync_op carries user_id) and can be traced.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise BusinessError(f"Bad add-on payload on {dish}: {raw!r}")

    out: list[tuple[int | None, str, int]] = []
    for m in raw:
        if not isinstance(m, dict):
            raise BusinessError(f"Bad add-on payload on {dish}: {m!r}")

        mod_id = m.get("modifier_id")
        if mod_id is not None:
            if isinstance(mod_id, bool) or not isinstance(mod_id, int):
                raise BusinessError(f"Bad modifier_id: {mod_id!r}")
            row = db.get(MenuModifier, mod_id)
            if row is None or not row.active:
                raise BusinessError(f"No such add-on, or it is inactive: {mod_id}")
            out.append((row.id, row.name_zh, row.price_cents))
            continue

        # a hand-typed request
        label = m.get("label")
        if not isinstance(label, str) or not label.strip():
            raise BusinessError(f"The custom request on {dish} needs some text")
        cents = m.get("price_cents", 0)
        if isinstance(cents, bool) or not isinstance(cents, int) or cents < 0:
            raise BusinessError(f"Bad amount on a custom request: {cents!r}")
        out.append((None, label.strip(), cents))

    return out


def _add_lines(db: Session, chk: DiningCheck, raw, client_ts: datetime) -> None:
    """Add dishes to a check. **Dine-in uses this too** -- one person at a
    table on the buffet while another orders a dish is, in the data, the same
    thing as a to-go order.

    The server resolves every price. The only exception is an open_price item
    (buffet takeout by weight), where the amount can only come off the scale.
    """
    if not isinstance(raw, list) or not raw:
        raise BusinessError("There are no dishes to add")

    for item in raw:
        if not isinstance(item, dict):
            raise BusinessError(f"Bad dish payload: {item!r}")

        mid = item.get("menu_item_id")
        if not isinstance(mid, int):
            raise BusinessError(f"Bad menu_item_id: {mid!r}")

        mi = db.get(MenuItem, mid)
        if mi is None or not mi.active:
            raise BusinessError(f"No such dish, or it is off the menu: {mid}")

        qty = item.get("qty", 1)
        if isinstance(qty, bool) or not isinstance(qty, int) or qty <= 0:
            raise BusinessError(f"Bad quantity: {qty!r}")

        if mi.open_price:
            amt = item.get("amount_cents")
            if isinstance(amt, bool) or not isinstance(amt, int) or amt <= 0:
                raise BusinessError(f"{mi.name_en} needs an amount")
            price = amt
        else:
            if mi.price_cents is None:
                raise BusinessError(f"{mi.name_en} has no price and cannot be ordered on its own")
            price = mi.price_cents

        notes = item.get("notes")
        notes = notes.strip() if isinstance(notes, str) and notes.strip() else None

        mods = _resolve_modifiers(db, item.get("modifiers"), mi.name_zh)

        line = OrderLine(
            check_id=chk.id,
            menu_item_id=mi.id,
            qty=qty,
            # Price snapshot -- changing the menu never changes a past check.
            # ⚠️ Add-on money is **folded into the unit price**: everything that
            #    computes money (total due, service charge base, tax base, the
            #    month report) is SUM(qty x unit_price_cents), so none of them
            #    change and none of them can be missed. What was added is
            #    kept separately in order_line_modifier.
            unit_price_cents=price + sum(m[2] for m in mods),
            notes=notes,
            status="placed",
            placed_at=client_ts,
        )
        db.add(line)

        if mods:
            db.flush()  # we need line.id
            for modifier_id, label, cents in mods:
                db.add(
                    OrderLineModifier(
                        order_line_id=line.id,
                        modifier_id=modifier_id,
                        label=label,
                        price_cents=cents,
                    )
                )


def open_togo_check(db: Session, op_id: uuidlib.UUID, payload: dict,
                    client_ts: datetime, user_id: int | None) -> None:
    """Open a to-go check.

    Two kinds:
      buffet_togo  buffet by weight -- the scale gives the amount, the front types it in
      phone_order  ordered off the menu over the phone

    **No table and no large-party charge** -- the service charge counts
    head_charge rows, a to-go check has none, so it comes out 0 with no
    special case needed.
    """
    source = payload.get("source")
    if source not in ("buffet_togo", "phone_order"):
        raise BusinessError(f"Bad to-go kind: {source!r}")

    period = resolve_period(db, client_ts)
    chk = DiningCheck(
        client_uuid=op_id,
        table_id=None,
        period_id=period.id,
        source=source,
        status="open",
        opened_at=client_ts,
        opened_by=user_id,
    )
    db.add(chk)
    db.flush()

    _add_lines(db, chk, payload.get("lines"), client_ts)
    # ⚠️ This line was missing once, and **to-go checks were never taxed**.
    #
    #    The service charge genuinely does not apply -- it counts dine-in
    #    heads, and _party_size is 0 for to-go, so it comes out 0 anyway.
    #
    #    It cost more than the tax: the client's estimate **does** include
    #    tax, staff collect what the screen says, and the server recorded a
    #    pre-tax total -- so the check immediately read as overpaid and the
    #    month report kept flagging it. add_order_lines already recalculated,
    #    so the same kind of check was taxed two different ways.
    _recalc_service_charge(db, chk)

    name = payload.get("customer_name")
    phone = payload.get("phone_last4")
    promised = payload.get("promised_at")
    if name or phone or promised:
        db.add(
            PickupOrder(
                check_id=chk.id,
                customer_name=(name or None),
                # PII: keep the last four only, enough to identify the guest
                phone_last4=(str(phone)[-4:] if phone else None),
                promised_at=promised,
                status="placed",
            )
        )


def add_order_lines(db: Session, payload: dict, client_ts: datetime) -> None:
    """Add dishes to an existing check. **Dine-in included** -- a table of two
    with one on the buffet and one ordering a dish is exactly this case.
    """
    chk = _load_check(db, payload)
    if chk.status not in ("open", "closed"):
        raise BusinessError(f"A {chk.status} check cannot take more dishes")

    _add_lines(db, chk, payload.get("lines"), client_ts)
    # Adding dishes changes the amount, so the large-party charge is recomputed
    _recalc_service_charge(db, chk)


def void_order_line(db: Session, payload: dict, client_ts: datetime) -> None:
    """Void one dish (cooked wrong, or the guest changed their mind).

    **Not physically deleted**, only marked voided -- voided dishes go into
    the owner's report, and deleting one means it never happened.
    """
    chk = _load_check(db, payload)
    line_id = payload.get("line_id")
    if not isinstance(line_id, int):
        raise BusinessError(f"Bad line_id: {line_id!r}")

    line = db.get(OrderLine, line_id)
    if line is None or line.check_id != chk.id:
        raise BusinessError("That dish is not on this check")
    if line.status == "voided":
        return  # idempotent

    line.status = "voided"
    _recalc_service_charge(db, chk)
