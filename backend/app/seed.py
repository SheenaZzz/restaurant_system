"""种子数据：20 张桌 + 菜单 + 人头价 + 三个账号。

幂等 —— 反复跑不会重复插入，也不会覆盖已有数据。
    docker compose exec api python -m app.seed

⚠️ 这里的菜名和价格是**占位数据**，用来把流程跑通。
   Step 4 前必须换成店里真实的菜单和价格。
"""

from datetime import date

from argon2 import PasswordHasher
from sqlalchemy import select

from .db import SessionLocal
from .models import AppUser, BuffetPrice, DiningTable, MenuItem

ph = PasswordHasher()


# --- 20 张桌：A 区 8 张（4 人）、B 区 8 张（4 人）、C 区 4 张（大桌）---
TABLES = (
    [(f"A{i}", 4, "main") for i in range(1, 9)]
    + [(f"B{i}", 4, "main") for i in range(1, 9)]
    + [(f"C{i}", 8, "large") for i in range(1, 5)]
)

# (name_en, name_zh, category, price_cents, is_buffet_dish, station)
# price_cents=None 表示 buffet 台上的菜，不单独计价
MENU: list[tuple[str, str, str, int | None, bool, str]] = [
    # --- buffet 台上的菜：不计价，但**要建档**，否则补菜事件没有对象可挂 ---
    ("General Tso's Chicken", "左宗棠鸡", "buffet_entree", None, True, "wok"),
    ("Sesame Chicken", "芝麻鸡", "buffet_entree", None, True, "wok"),
    ("Broccoli Beef", "西兰花牛肉", "buffet_entree", None, True, "wok"),
    ("Sweet & Sour Pork", "咕咾肉", "buffet_entree", None, True, "wok"),
    ("Lo Mein", "捞面", "buffet_noodle", None, True, "wok"),
    ("Fried Rice", "炒饭", "buffet_rice", None, True, "wok"),
    ("Salt & Pepper Shrimp", "椒盐虾", "buffet_seafood", None, True, "fryer"),
    ("Crab Rangoon", "蟹角", "buffet_appetizer", None, True, "fryer"),
    ("Spring Roll", "春卷", "buffet_appetizer", None, True, "fryer"),
    ("Hot & Sour Soup", "酸辣汤", "buffet_soup", None, True, "wok"),
    ("Salad Bar", "沙拉吧", "buffet_cold", None, True, "cold"),
    ("Fresh Fruit", "水果", "buffet_dessert", None, True, "cold"),
    # --- 单点菜品：进后厨，要出票 ---
    ("Peking Duck (Half)", "北京烤鸭（半只）", "entree", 2899, False, "wok"),
    ("Salt & Pepper Lobster", "椒盐龙虾", "entree", 3299, False, "wok"),
    ("Steamed Whole Fish", "清蒸全鱼", "entree", 2699, False, "wok"),
    ("Walnut Shrimp", "核桃虾", "entree", 1899, False, "wok"),
    # --- 饮料：station='drink'，**不进后厨队列** ---
    #     注意：按人无限续杯的汽水走 head_charge，不走这里。
    #     这里只放单独计价的特饮。
    ("Thai Iced Tea", "泰式奶茶", "drink", 495, False, "drink"),
    ("Fresh Coconut", "椰子", "drink", 695, False, "drink"),
    ("Bottled Water", "瓶装水", "drink", 150, False, "none"),
]

# 人头价（占位）。改价时**新增一行**并给新的 effective_from，
# 绝不覆盖旧行 —— 否则历史账单金额会跟着变。
PRICES = [
    ("lunch", "admission", "adult", 1299),
    ("lunch", "admission", "child", 699),
    ("lunch", "admission", "senior", 1099),
    ("dinner", "admission", "adult", 1899),
    ("dinner", "admission", "child", 999),
    ("dinner", "admission", "senior", 1599),
    # 饮料按人无限续杯 —— 所以它是第二项人头费，不是单品
    ("lunch", "drink", None, 250),
    ("dinner", "drink", None, 250),
]

# ⚠️ 开发用弱口令。Step 3 上线前必须改，且改成每人独立的密码。
USERS = [
    ("front", "前台", "front", "front-dev-pw", "1111"),
    ("kitchen", "后厨", "kitchen", "kitchen-dev-pw", "2222"),
    ("admin", "老板", "admin", "admin-dev-pw", None),
]


def seed() -> None:
    db = SessionLocal()
    added: dict[str, int] = {}
    try:
        # --- 桌 ---
        existing = {t.label for t in db.scalars(select(DiningTable)).all()}
        n = 0
        for i, (label, seats, zone) in enumerate(TABLES):
            if label in existing:
                continue
            db.add(DiningTable(label=label, seats=seats, zone=zone, sort_order=i))
            n += 1
        added["dining_table"] = n

        # --- 菜单 ---
        existing_menu = {m.name_en for m in db.scalars(select(MenuItem)).all()}
        n = 0
        for i, (en, zh, cat, price, is_buffet, station) in enumerate(MENU):
            if en in existing_menu:
                continue
            db.add(
                MenuItem(
                    name_en=en,
                    name_zh=zh,
                    category=cat,
                    price_cents=price,
                    is_buffet_dish=is_buffet,
                    station=station,
                    sort_order=i,
                )
            )
            n += 1
        added["menu_item"] = n

        # --- 人头价 ---
        have_price = db.scalar(select(BuffetPrice.id).limit(1)) is not None
        n = 0
        if not have_price:
            for kind, charge, guest, cents in PRICES:
                db.add(
                    BuffetPrice(
                        period_kind=kind,
                        charge_kind=charge,
                        guest_type=guest,
                        price_cents=cents,
                        effective_from=date(2026, 1, 1),
                    )
                )
                n += 1
        added["buffet_price"] = n

        # --- 账号 ---
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
    print("seed 完成（幂等，可重复执行）")


if __name__ == "__main__":
    seed()
