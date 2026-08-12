"""The buffet: its layout (buffet_dish) and its refill events (tray_event).

Refill events are this project's only way in to a quantity that **cannot be
observed directly**: nobody can read the rate of consumption, only
interval-censored events -- filled at t1, found empty at t2. So every field
on this path serves "can this be modelled afterwards", not "is this easy to render".
"""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import BuffetDish, TrayEvent

PERIODS = ("lunch", "dinner")
PAGES = 3
SLOTS = 10

# The board has three buttons: full / half / empty.
# discard (thrown away) is the only source for waste, but it adds work at the counter -- once these three are running.
EVENT_TYPES = ("refill", "half", "empty", "discard")

# How far back an entry may be dated. A "late entry" beyond three hours is a
# guess, and feeding guesses in only pollutes the interval endpoints.
MAX_BACKDATE_MIN = 180


class BuffetError(Exception):
    """A validation failure. sync turns it into this op's rejection reason."""


def load_board(db: Session) -> dict[str, list[dict]]:
    """The whole board, grouped by period. Published by /api/catalog -- the refill page has to work offline."""
    rows = db.scalars(
        select(BuffetDish)
        .where(BuffetDish.active.is_(True))
        .order_by(BuffetDish.period_kind, BuffetDish.page, BuffetDish.pos)
    ).all()
    out: dict[str, list[dict]] = {p: [] for p in PERIODS}
    for r in rows:
        out.setdefault(r.period_kind, []).append(
            {
                "id": r.id,
                "page": r.page,
                "pos": r.pos,
                "name_zh": r.name_zh,
                "name_en": r.name_en,
            }
        )
    return out


def record_tray_event(
    db: Session, payload: dict, client_ts: datetime, user_id: int | None
) -> None:
    """Record one refill / ran-empty. **Append-only: no update, no delete.**

    Tapped the wrong one? Record the right one straight after. Two events
    seconds apart are distinguishable when modelling, while a fact table that
    can be edited loses all its credibility -- nobody could then say whether a
    row was recorded at the time or changed later.

    The time does not come from the server's now():
      observed_at = the op's timestamp on the device - the minutes backdated
    A record queued offline for two hours has to land **then**, not on arrival.
    """
    dish_id = payload.get("dish_id")
    if not isinstance(dish_id, int):
        raise BuffetError(f"Bad dish_id: {dish_id!r}")

    kind = payload.get("event_type")
    if kind not in EVENT_TYPES:
        raise BuffetError(f"Bad event type: {kind!r}")

    back = payload.get("minutes_ago", 0)
    if not isinstance(back, int) or not 0 <= back <= MAX_BACKDATE_MIN:
        raise BuffetError(f"Bad backdate in minutes: {back!r}")

    dish = db.get(BuffetDish, dish_id)
    if dish is None:
        raise BuffetError(f"That dish is not on the board: {dish_id}")

    db.add(
        TrayEvent(
            buffet_dish_id=dish_id,
            event_type=kind,
            observed_at=client_ts - timedelta(minutes=back),
            recorded_by=user_id,
        )
    )


def set_board(db: Session, period_kind: str, rows: list[dict]) -> None:
    """Replace one board wholesale, in order (what the owner's page sends).

    Same rule as the add-on catalogue: rows with an id are edited in place,
    rows without are added, and **anything missing from the list is
    deactivated** -- not deleted, since tray_event points at it and deleting
    would orphan the refill history.

    ⚠️ Editing in place is a rename and history carries over; a different dish
       means deleting the row and adding one, or the new dish inherits the old
       one's consumption history. The UI says so too.
    """
    if period_kind not in PERIODS:
        raise BuffetError(f"Bad period: {period_kind}")

    kept: list[BuffetDish] = []
    for r in rows:
        page, pos = r["page"], r["pos"]
        if not (1 <= page <= PAGES and 1 <= pos <= SLOTS):
            raise BuffetError(f"Position out of range: page {page}, slot {pos}")
        name = (r.get("name_zh") or "").strip()
        if not name:
            raise BuffetError("A dish needs a name")

        rid = r.get("id")
        if rid is None:
            row = BuffetDish(period_kind=period_kind, page=page, pos=pos, name_zh=name)
            db.add(row)
        else:
            row = db.get(BuffetDish, rid)
            if row is None or row.period_kind != period_kind:
                raise BuffetError(f"That dish is not on this board: {rid}")
            row.page = page
            row.pos = pos
            row.name_zh = name
        row.name_en = (r.get("name_en") or "").strip()
        row.active = True
        kept.append(row)

    # ⚠️ Track objects, not ids: a new row has no id before flush, so an id set
    #    would make the deactivation loop below treat it as "not in the list".
    db.flush()
    keep_ids = {r.id for r in kept}
    for row in db.scalars(
        select(BuffetDish).where(
            BuffetDish.period_kind == period_kind, BuffetDish.active.is_(True)
        )
    ):
        if row.id not in keep_ids:
            row.active = False
