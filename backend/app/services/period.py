"""Resolving service periods and business days.

Every check hangs off a service_period. The front should not be opening and
closing periods by hand -- nobody remembers at peak, and a forgotten tap
leaves the whole day's checks with nothing to hang off. So it is decided by
the clock and created on demand.

This module is the **only definition of the business day**. The front end must
not keep its own copy -- two constants drift, and the hole that opens only
shows up at reconciliation. What the front end needs is published by
/api/catalog (see api/catalog.py).
"""

import logging
import os
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import ServicePeriod, StoreSetting

log = logging.getLogger(__name__)

# env is only a **bootstrap default**: before that row exists (a fresh
# database, before migrations) something has to work. In normal operation the
# store_setting table wins, and an owner's edit takes effect immediately --
# rebuilding a container is not something a restaurant can do.
_ENV_TZ = os.getenv("STORE_TZ", "America/Los_Angeles")
_ENV_CUTOFF_HOUR = int(os.getenv("BUSINESS_DAY_CUTOFF_HOUR", "0"))

# Where lunch becomes dinner (store local time).
# The menu prints it: lunch buffet 11:00-15:00, dinner buffet 15:00-20:30.
# It is printed on the menu, so it is not a setting.
LUNCH_TO_DINNER = time(15, 0)


@dataclass(frozen=True)
class StoreClock:
    """The store's clock: its time zone and where the business day starts.

    ⚠️ An IANA time zone name, never a fixed offset.
       This used to be a hard-coded STORE_UTC_OFFSET=-5 (EST) while the store
       is on Pacific time -- two hours out, so 13:00 counted as dinner and
       lunch checks were charged the dinner price ($15.88 against $14.05).
       That is the kind of mistake that overcharges a guest.

       The day boundary is 00:00 now, and a fixed offset is an hour out on the
       two DST changeover days. The old 02:00 cutoff happened to keep the DST
       switch (also 02:00) outside the business day, so a wrong offset stayed
       invisible; at 00:00 that cushion is gone and the real zone is required.
    """

    tz: ZoneInfo
    cutoff_hour: int

    @property
    def cutoff(self) -> time:
        return time(self.cutoff_hour, 0)

    def now(self) -> datetime:
        """The store's local time right now (tz-aware)."""
        return datetime.now(self.tz)

    def local(self, at: datetime | None) -> datetime:
        """Convert any instant to store local time. None means now.

        A naive input is treated as store time -- never guessed as UTC. Guessing
        wrong files the whole check on the wrong business day, silently.
        """
        if at is None:
            return self.now()
        if at.tzinfo is None:
            return at.replace(tzinfo=self.tz)
        return at.astimezone(self.tz)

    def business_date(self, local_dt: datetime) -> date:
        """Which business day an instant belongs to. It has to be store local time already."""
        if local_dt.time() < self.cutoff:
            return (local_dt - timedelta(days=1)).date()
        return local_dt.date()

    def period_kind(self, local_dt: datetime) -> str:
        # With a non-zero cutoff, small-hours checks belong to the previous day's dinner.
        # At cutoff 0 this branch never fires; it is kept so moving back to 2 still behaves.
        if local_dt.time() < self.cutoff:
            return "dinner"
        return "lunch" if local_dt.time() < LUNCH_TO_DINNER else "dinner"


def _zone(name: str) -> ZoneInfo | None:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def load_store_clock(db: Session) -> StoreClock:
    """Read the store clock from store_setting.

    Repeated calls in one Session do not re-query -- db.get() hits the identity
    map, so calling resolve_period once per op in a batch costs nothing extra.

    A missing or invalid value falls back to the env default and **says so**:
    a POS cannot refuse to start because someone hand-edited a bad time zone
    into the settings table, but it must not quietly run on a different
    definition either -- that would silently re-file every check.
    """
    row = db.get(StoreSetting, 1)
    if row is None:
        # Fresh database, migrations have not reached this row. Unreachable in normal operation.
        return StoreClock(tz=_zone(_ENV_TZ) or ZoneInfo("UTC"), cutoff_hour=_ENV_CUTOFF_HOUR)

    tz = _zone(row.tz)
    if tz is None:
        log.error(
            "store_setting.tz=%r is not a valid IANA name; falling back to %r. "
            "The business day and lunch/dinner split may be wrong -- set it again in Settings.",
            row.tz,
            _ENV_TZ,
        )
        tz = _zone(_ENV_TZ) or ZoneInfo("UTC")

    return StoreClock(tz=tz, cutoff_hour=row.business_day_cutoff_hour)


def resolve_period(db: Session, at: datetime | None = None) -> ServicePeriod:
    """Get (creating if needed) the service period an instant belongs to.

    ⚠️ Uses the op's client_ts rather than the server clock -- a check queued
    offline for two hours has to land in the period it **actually** happened in,
    or lunch checks end up counted as dinner.
    """
    clock = load_store_clock(db)
    local = clock.local(at)
    bdate = clock.business_date(local)
    kind = clock.period_kind(local)

    period = db.scalar(
        select(ServicePeriod).where(
            ServicePeriod.business_date == bdate, ServicePeriod.kind == kind
        )
    )
    if period is None:
        period = ServicePeriod(
            business_date=bdate,
            kind=kind,
            opened_at=at or clock.now(),
        )
        db.add(period)
        db.flush()
    return period
