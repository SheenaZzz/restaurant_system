"""The store's menu, loaded from data/menu.json.

Taken off HUNAN Chinese Restaurant's takeout sheet. Prices are in cents, and
the category order is the order the ordering screen shows.

It lives in a JSON file rather than in this module because it is **the store's
data, not code**: the owner changes dishes and prices, and those edits should
not read as a code change. Dish and category names are bilingual there for the
same reason -- they are data, so they never go through the UI catalogue.

⚠️ Not printed on the menu (seed.py uses placeholders that need confirming
   with the store):
   - child / senior buffet prices (the menu prints one price)
   - buffet drink prices
"""

import json
from pathlib import Path

_DATA = json.loads(
    (Path(__file__).parent / "data" / "menu.json").read_text(encoding="utf-8")
)

# (name_en, name_zh, category, price_cents, station)
#
# station decides whether it reaches the kitchen queue:
#   wok/fryer/cold -> ticket    drink/none -> no ticket
MENU_ITEMS: list[tuple[str, str, str, int, str]] = [
    (i["name_en"], i["name_zh"], i["category"], i["price_cents"], i["station"])
    for i in _DATA["items"]
]

# Display name and order of the categories.
# (key, Chinese, English). The English is for the language switch -- dishes
# carry their own name_en, and a category left in Chinese would stand out.
CATEGORIES: list[tuple[str, str, str]] = [
    (c["key"], c["name_zh"], c["name_en"]) for c in _DATA["categories"]
]

# Dishes on the buffet. No price -- they are covered by admission.
BUFFET_DISHES: list[tuple[str, str, str, str]] = [
    (d["name_en"], d["name_zh"], d["category"], d["station"])
    for d in _DATA["buffet_dishes"]
]

# (username, display_name, role, dev password, dev PIN)
# ⚠️ Weak development passwords. They have to be replaced before going live,
#    with one per person.
SEED_USERS: list[tuple[str, str, str, str, str | None]] = [
    (u["username"], u["display_name"], u["role"], u["dev_password"], u["dev_pin"])
    for u in _DATA["users"]
]
