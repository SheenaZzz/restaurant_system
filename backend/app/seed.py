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
from .menu_data import MENU_ITEMS
from .models import AppUser, BuffetPrice, DiningTable, MenuItem

ph = PasswordHasher()


# --- 20 张桌：A 区 8 张（4 人）、B 区 8 张（4 人）、C 区 4 张（大桌）---
TABLES = (
    [(f"A{i}", 4, "main") for i in range(1, 9)]
    + [(f"B{i}", 4, "main") for i in range(1, 9)]
    + [(f"C{i}", 8, "large") for i in range(1, 5)]
)

# Buffet 台上的菜：不计价，但**要建档** —— 否则补菜事件没有对象可挂。
# Step 5 上线补菜记录时会用到，菜名等店里确认后再补全。
BUFFET_DISHES = [
    ("General Tso's Chicken", "左宗棠鸡", "buffet_entree", "wok"),
    ("Sesame Chicken", "芝麻鸡（自助）", "buffet_entree", "wok"),
    ("Broccoli Beef", "西兰花牛肉（自助）", "buffet_entree", "wok"),
    ("Sweet & Sour Pork", "咕咾肉（自助）", "buffet_entree", "wok"),
    ("Lo Mein", "捞面（自助）", "buffet_noodle", "wok"),
    ("Fried Rice", "炒饭（自助）", "buffet_rice", "wok"),
    ("Salt & Pepper Shrimp", "椒盐虾（自助）", "buffet_seafood", "fryer"),
    ("Crab Rangoon", "蟹角（自助）", "buffet_appetizer", "fryer"),
    ("Spring Roll", "春卷（自助）", "buffet_appetizer", "fryer"),
    ("Hot & Sour Soup", "酸辣汤（自助）", "buffet_soup", "wok"),
    ("Salad Bar", "沙拉吧", "buffet_cold", "cold"),
    ("Fresh Fruit", "水果", "buffet_dessert", "cold"),
]

# 自提专用：金额由前台当场输入（秤上直接出数），系统只记账
TOGO_ITEMS = [
    ("Buffet To Go (by weight)", "自助餐打包（按重量）", "togo", "none"),
]

# 人头价（占位）。改价时**新增一行**并给新的 effective_from，
# 绝不覆盖旧行 —— 否则历史账单金额会跟着变。
PRICES = [
    # ✅ 成人价来自菜单：午市 $14.05、晚市 $15.88
    ("lunch", "admission", "adult", 1405),
    ("dinner", "admission", "adult", 1588),
    # ⚠️ 菜单上**没有印**儿童和长者价，下面是占位值，需要跟店里确认后改。
    #    改价的正确做法是新增一行 + 新的 effective_from，不要覆盖这几行。
    ("lunch", "admission", "child", 699),
    ("lunch", "admission", "senior", 1099),
    ("dinner", "admission", "child", 999),
    ("dinner", "admission", "senior", 1399),
    # 饮料按人无限续杯 —— 所以它是第二项人头费，不是单品。
    # ⚠️ 菜单上也没有印饮料价，下面同样是占位值。
    #    儿童饮料另有价格；长者饮料按成人价，所以没有 senior 这一档。
    ("lunch", "drink", "adult", 250),
    ("lunch", "drink", "child", 150),
    ("dinner", "drink", "adult", 250),
    ("dinner", "drink", "child", 150),
]

# ⚠️ 开发用弱口令。Step 3 上线前必须改，且改成每人独立的密码。
# (username, 显示名, role, 密码, PIN)
# ⚠️ 账号名和角色名是两回事：
#    账号名是人登录时打的字，角色名是代码里做权限判断的键。
#    这里只改账号名，角色名保持 front_employee / front_manager / kitchen / admin ——
#    改角色名要动数据库约束、RBAC 表和一堆判断，收益为零。
USERS = [
    ("manager", "前台主管", "front_manager", "manager-dev-pw", "1111"),
    ("front", "前台员工", "front_employee", "front-dev-pw", "3333"),
    ("kitchen", "后厨", "kitchen", "kitchen-dev-pw", "2222"),
    ("boss", "老板", "admin", "boss-dev-pw", None),
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

        # --- 菜单：单品 + buffet 台上的菜 + 自提条目 ---
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

        # --- 人头价：逐行幂等（不能整表判断，否则新增档位加不进去）---
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
