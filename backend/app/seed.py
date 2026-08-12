"""Seed data: 20 tables + the menu + per-head prices + the accounts.

Idempotent -- running it again inserts nothing twice and overwrites nothing.
    docker compose exec api python -m app.seed

⚠️ Dish names and prices live in data/menu.json (the store's data, not code).
   The per-head prices below are still placeholders and need confirming.
"""

from datetime import date
from decimal import Decimal

from argon2 import PasswordHasher
from sqlalchemy import select

from .db import SessionLocal
from .menu_data import (
    BUFFET_DISHES as _BUFFET_DISHES,
    MENU_ITEMS,
    SEED_USERS as _SEED_USERS,
)
from .models import AppUser, BuffetPrice, DiningTable, MenuItem, TaxRate

ph = PasswordHasher()


# --- 20 tables: 8 in zone A (4 seats), 8 in zone B (4 seats), 4 in zone C (large) ---
TABLES = (
    [(f"A{i}", 4, "main") for i in range(1, 9)]
    + [(f"B{i}", 4, "main") for i in range(1, 9)]
    + [(f"C{i}", 8, "large") for i in range(1, 5)]
)

# Dishes on the buffet: not priced, but they **need a record** -- otherwise a
# refill event has nothing to hang off. Names come from data/menu.json.
BUFFET_DISHES = _BUFFET_DISHES

# To-go only: the front types the amount in (it comes off the scale); the system just records it
TOGO_ITEMS = [
    ("Buffet To Go (by weight)", "Buffet To Go (by weight)", "togo", "none"),
]

# Per-head prices (placeholders). A price change **adds a row** with a new
# effective_from and never overwrites -- overwriting would restate past checks.
PRICES = [
    # Adult prices come off the menu: lunch $14.05, dinner $15.88
    ("lunch", "admission", "adult", 1405),
    ("dinner", "admission", "adult", 1588),
    # ⚠️ Child and senior prices are **not printed** on the menu. These are
    #    placeholders to confirm with the store. Change them by adding a row
    ("lunch", "admission", "child", 699),
    ("lunch", "admission", "senior", 1099),
    ("dinner", "admission", "child", 999),
    ("dinner", "admission", "senior", 1399),
    # Drinks are per person with free refills, so they are a second per-head charge, not a dish.
    # ⚠️ Drink prices are not printed either; placeholders again.
    #    Child drinks are priced separately; seniors pay the adult price, so there is no senior tier.
    ("lunch", "drink", "adult", 250),
    ("lunch", "drink", "child", 150),
    ("dinner", "drink", "adult", 250),
    ("dinner", "drink", "child", 150),
]

# ⚠️ Weak development passwords. They have to be replaced before going live,
#    with one per person. The list itself is in data/menu.json.
# ⚠️ A username and a role are different things: the username is what someone
#    types to sign in, the role is the key the permission checks read. Only
#    usernames are edited here -- roles stay front_employee / front_manager /
#    kitchen / admin, since renaming them would touch database constraints,
#    the permission table and a pile of checks, for no gain.
USERS = _SEED_USERS


def seed() -> None:
    db = SessionLocal()
    added: dict[str, int] = {}
    try:
        # --- tables ---
        existing = {t.label for t in db.scalars(select(DiningTable)).all()}
        n = 0
        for i, (label, seats, zone) in enumerate(TABLES):
            if label in existing:
                continue
            db.add(DiningTable(label=label, seats=seats, zone=zone, sort_order=i))
            n += 1
        added["dining_table"] = n

        # --- menu: dishes, buffet dishes, and the to-go item ---
        existing_menu = {m.name_en for m in db.scalars(select(MenuItem)).all()}
        n = 0
        i = 0
        for en, zh, cat, price, station in MENU_ITEMS:
            if en not in existing_menu:
                db.add(MenuItem(name_en=en, name_zh=zh, category=cat,
                                price_cents=price, is_buffet_dish=False,
                                station=station, sort_order=i))
                n += 1
                existing_menu.add(en)
            i += 1
        for en, zh, cat, station in BUFFET_DISHES:
            if en not in existing_menu:
                db.add(MenuItem(name_en=en, name_zh=zh, category=cat,
                                price_cents=None, is_buffet_dish=True,
                                station=station, sort_order=i))
                n += 1
                existing_menu.add(en)
            i += 1
        for en, zh, cat, station in TOGO_ITEMS:
            if en not in existing_menu:
                db.add(MenuItem(name_en=en, name_zh=zh, category=cat,
                                price_cents=0, is_buffet_dish=False,
                                station=station, sort_order=i, open_price=True))
                n += 1
                existing_menu.add(en)
            i += 1
        added["menu_item"] = n

        # --- per-head prices: row by row (a whole-table check would never add a new tier) ---
        existing_prices = {
            (p.period_kind, p.charge_kind, p.guest_type, p.effective_from)
            for p in db.scalars(select(BuffetPrice)).all()
        }
        n = 0
        eff = date(2026, 1, 1)
        for kind, charge, guest, cents in PRICES:
            if (kind, charge, guest, eff) in existing_prices:
                continue
            db.add(
                BuffetPrice(
                    period_kind=kind,
                    charge_kind=charge,
                    guest_type=guest,
                    price_cents=cents,
                    effective_from=eff,
                )
            )
            n += 1
        added["buffet_price"] = n

        # --- tax rate ---
        # ⚠️ 7.1% is Gardnerville's rate (Douglas County, NV) and **needs
        #    confirming with the store**. Set once; change it in Settings,
        if db.scalar(select(TaxRate.id).limit(1)) is None:
            db.add(TaxRate(rate=Decimal("0.07100"), effective_from=date(2026, 1, 1),
                           note="placeholder: Douglas County NV, to confirm"))
            added["tax_rate"] = 1
        else:
            added["tax_rate"] = 0

        # --- accounts ---
        existing_users = {u.username for u in db.scalars(select(AppUser)).all()}
        n = 0
        for username, display, role, pw, pin in USERS:
            if username in existing_users:
                continue
            db.add(
                AppUser(
                    username=username,
                    display_name=display,
                    role=role,
                    password_hash=ph.hash(pw),
                    pin_hash=ph.hash(pin) if pin else None,
                )
            )
            n += 1
        added["app_user"] = n

        db.commit()
    finally:
        db.close()

    for table, count in added.items():
        print(f"  {table}: +{count}")
    print("seed done (idempotent, safe to re-run)")


if __name__ == "__main__":
    seed()
