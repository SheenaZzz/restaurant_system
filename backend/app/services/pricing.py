"""Resolving prices.

**Prices are always resolved on the server; an amount from the client is never trusted.**

Two reasons:
  1. the client may be holding prices cached days ago (certain to, offline)
  2. recording whatever amount the front end sends = anyone can discount themselves

The client's cached prices only put a number on the screen first; what gets stored is the server's.
"""

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import BuffetPrice


def resolve_head_prices(
    db: Session, period_kind: str, on: date
) -> dict[tuple[str, str], int]:
    """Returns {(charge_kind, guest_type): price_cents}.

    Takes the newest row with effective_from <= on -- a price change **adds a
    row** rather than overwriting, so past checks keep the price they were charged.
    """
    rows = db.scalars(
        select(BuffetPrice)
        .where(
            BuffetPrice.period_kind == period_kind,
            BuffetPrice.effective_from <= on,
        )
        .order_by(BuffetPrice.effective_from)
    ).all()

    out: dict[tuple[str, str], int] = {}
    for r in rows:  # ascending effective_from, so later rows win
        out[(r.charge_kind, r.guest_type)] = r.price_cents
    return out
