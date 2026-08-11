"""真实菜单，照 HUNAN Chinese Restaurant 的外卖单录入。

价格单位是分。分类顺序就是点单界面上的顺序。

⚠️ 菜单上**没有**的信息（seed.py 里用的是占位值，需要跟店里确认）：
   - 儿童 / 长者 buffet 价格（菜单只印了一个价）
   - buffet 饮料价格
"""

# (name_en, name_zh, category, price_cents, station)
#
# station 决定要不要进后厨队列：
#   wok/fryer/cold → 出票    drink/none → 不出票
MENU_ITEMS: list[tuple[str, str, str, int, str]] = [
    # --- 午市特餐（11:00–15:00，含例汤、蟹角、春卷、饭）---
    ("Sweet and Sour Pork (Lunch)", "咕咾肉（午市）", "lunch_special", 1120, "wok"),
    ("Chicken with Garlic Sauce (Lunch)", "鱼香鸡（午市）", "lunch_special", 1120, "wok"),
    ("Mongolian Chicken (Lunch)", "蒙古鸡（午市）", "lunch_special", 1120, "wok"),
    ("Vegetable Deluxe (Lunch)", "素什锦（午市）", "lunch_special", 1120, "wok"),
    ("Almond Chicken (Lunch)", "杏仁鸡（午市）", "lunch_special", 1120, "wok"),
    ("Cashew Chicken (Lunch)", "腰果鸡（午市）", "lunch_special", 1120, "wok"),
    ("General Chicken (Lunch)", "左宗鸡（午市）", "lunch_special", 1120, "wok"),
    ("Mushroom Chicken (Lunch)", "蘑菇鸡（午市）", "lunch_special", 1120, "wok"),
    ("Lemon Chicken (Lunch)", "柠檬鸡（午市）", "lunch_special", 1120, "wok"),
    ("Sweet and Sour Chicken (Lunch)", "甜酸鸡（午市）", "lunch_special", 1120, "wok"),
    ("Hunan Chicken (Lunch)", "湖南鸡（午市）", "lunch_special", 1120, "wok"),
    ("Broccoli Chicken (Lunch)", "芥兰鸡（午市）", "lunch_special", 1120, "wok"),
    ("Kung Pao Chicken (Lunch)", "宫保鸡（午市）", "lunch_special", 1120, "wok"),
    ("Kung Pao Beef (Lunch)", "宫保牛（午市）", "lunch_special", 1215, "wok"),
    ("Hunan Beef (Lunch)", "湖南牛（午市）", "lunch_special", 1215, "wok"),
    ("Broccoli Beef (Lunch)", "芥兰牛（午市）", "lunch_special", 1215, "wok"),
    ("Mongolian Beef (Lunch)", "蒙古牛（午市）", "lunch_special", 1215, "wok"),
    ("Green Pepper Beef (Lunch)", "青椒牛（午市）", "lunch_special", 1215, "wok"),
    ("Vegetable Beef (Lunch)", "蔬菜牛（午市）", "lunch_special", 1215, "wok"),
    ("Broccoli Shrimp (Lunch)", "芥兰虾（午市）", "lunch_special", 1215, "wok"),
    ("Vegetable Shrimp (Lunch)", "蔬菜虾（午市）", "lunch_special", 1215, "wok"),
    ("Kung Pao Shrimp (Lunch)", "宫保虾（午市）", "lunch_special", 1215, "wok"),
    ("Hunan Shrimp (Lunch)", "湖南虾（午市）", "lunch_special", 1215, "wok"),
    # --- 开胃菜 ---
    ("Paper Wrapped Chicken (10)", "纸包鸡（10）", "appetizer", 1120, "fryer"),
    ("Egg Roll (4)", "春卷（4）", "appetizer", 470, "fryer"),
    ("Chicken Teriyaki (4)", "鸡串烧（4）", "appetizer", 750, "fryer"),
    ("Pot Stickers (14)", "锅贴（14）", "appetizer", 1030, "fryer"),
    ("Crab Rangoon Cheese (10)", "芝士蟹角（10）", "appetizer", 840, "fryer"),
    ("Barbecued Pork", "叉烧", "appetizer", 1120, "wok"),
    ("Fried Prawns (12)", "炸虾（12）", "appetizer", 1120, "fryer"),
    ("Barbecued Spareribs (4)", "烧排骨（4）", "appetizer", 1120, "wok"),
    ("Pu Pu Platter", "宝宝盘", "appetizer", 1588, "fryer"),
    # --- 汤 ---
    ("Hot Sour Soup", "酸辣汤", "soup", 655, "wok"),
    ("Egg Flower Soup", "蛋花汤", "soup", 655, "wok"),
    ("Won Ton Soup", "云吞汤", "soup", 845, "wok"),
    ("War Won Ton Soup", "窝云吞汤", "soup", 935, "wok"),
    ("Seafood Soup", "海鲜汤", "soup", 1405, "wok"),
    # --- 厨师特荐 ---
    ("Sesame Chicken", "芝麻鸡", "chef_special", 1310, "wok"),
    ("Black Pepper Chicken", "黑椒鸡", "chef_special", 1405, "wok"),
    ("Orange Chicken", "陈皮鸡", "chef_special", 1405, "wok"),
    ("Crispy Chicken", "脆皮鸡", "chef_special", 1405, "fryer"),
    ("Sesame Beef", "芝麻牛", "chef_special", 1405, "wok"),
    ("Szechuan Beef", "四川牛", "chef_special", 1405, "wok"),
    ("Sweet & Sour Three Flavors", "甜酸三样", "chef_special", 1495, "wok"),
    ("Crispy Shrimp", "脆皮虾", "chef_special", 1495, "fryer"),
    ("Walnut Shrimp", "核桃虾", "chef_special", 1495, "wok"),
    ("Sizzling Chicken", "铁板鸡", "chef_special", 1495, "wok"),
    ("Sizzling Beef", "铁板牛", "chef_special", 1495, "wok"),
    ("Sizzling Shrimp", "铁板虾", "chef_special", 1495, "wok"),
    ("Shrimp with Lobster Sauce", "虾龙糊", "chef_special", 1495, "wok"),
    ("Mongolian Three Flavors Delight", "蒙古三样", "chef_special", 1495, "wok"),
    ("Snow Peas Shrimp", "雪豆虾", "chef_special", 1495, "wok"),
    ("Sizzling Seafood", "铁板海鲜", "chef_special", 1682, "wok"),
    ("Happy Family", "全家福", "chef_special", 1682, "wok"),
    ("Dragon and Phoenix", "龙凤配", "chef_special", 1682, "wok"),
    ("Snow Peas Scallop", "雪豆干贝", "chef_special", 1775, "wok"),
    ("Kung Pao Scallop", "宫保干贝", "chef_special", 1775, "wok"),
    ("Scallop with Hot Garlic Sauce", "鱼香干贝", "chef_special", 1775, "wok"),
    # --- 海鲜 ---
    ("Broccoli Shrimp", "芥兰虾", "seafood", 1405, "wok"),
    ("Vegetable Shrimp", "蔬菜虾", "seafood", 1405, "wok"),
    ("Kung Pao Shrimp", "宫保虾", "seafood", 1405, "wok"),
    ("Shrimp with Garlic Sauce", "鱼香虾", "seafood", 1405, "wok"),
    ("Hunan Shrimp", "湖南虾", "seafood", 1405, "wok"),
    # --- 牛肉 ---
    ("Broccoli Beef", "芥兰牛", "beef", 1262, "wok"),
    ("Green Pepper Beef", "青椒牛", "beef", 1262, "wok"),
    ("Vegetable Beef", "蔬菜牛", "beef", 1262, "wok"),
    ("Beef with Garlic Sauce", "鱼香牛", "beef", 1262, "wok"),
    ("Kung Pao Beef", "宫保牛", "beef", 1262, "wok"),
    ("Mongolian Beef", "蒙古牛", "beef", 1262, "wok"),
    ("Snow Pea Beef", "雪豆牛", "beef", 1405, "wok"),
    # --- 鸡 ---
    ("Mongolian Chicken", "蒙古鸡", "chicken", 1120, "wok"),
    ("Pineapple Chicken", "凤梨鸡", "chicken", 1120, "wok"),
    ("Sweet and Sour Chicken", "甜酸鸡", "chicken", 1120, "wok"),
    ("Lemon Chicken", "柠檬鸡", "chicken", 1120, "wok"),
    ("Almond Chicken", "杏仁鸡", "chicken", 1120, "wok"),
    ("Cashew Chicken", "腰果鸡", "chicken", 1120, "wok"),
    ("Vegetable Chicken", "素菜鸡", "chicken", 1120, "wok"),
    ("Broccoli Chicken", "芥兰鸡", "chicken", 1120, "wok"),
    ("Mushroom Chicken", "蘑菇鸡", "chicken", 1120, "wok"),
    ("Chicken with Black Bean Sauce", "豆豉鸡", "chicken", 1120, "wok"),
    ("Kung Pao Chicken", "宫保鸡", "chicken", 1120, "wok"),
    ("Hunan Chicken", "湖南鸡", "chicken", 1120, "wok"),
    ("General's Chicken", "左宗鸡", "chicken", 1120, "wok"),
    ("Chicken with Garlic Sauce", "鱼香鸡", "chicken", 1120, "wok"),
    ("Snow Pea Chicken", "雪豆鸡", "chicken", 1307, "wok"),
    # --- 猪肉 ---
    ("Sweet and Sour Pork", "甜酸肉", "pork", 1120, "wok"),
    ("Broccoli Pork", "芥兰肉", "pork", 1120, "wok"),
    ("Pork with Garlic Sauce", "鱼香肉", "pork", 1120, "wok"),
    # --- 蔬菜 ---
    ("Mixed Vegetable", "素什锦", "vegetable", 1120, "wok"),
    ("Broccoli with Cashew Nuts", "腰果芥兰", "vegetable", 1120, "wok"),
    ("Family Style To Fu (Fried)", "家常豆腐", "vegetable", 1120, "wok"),
    ("Hot To Fu", "辣豆腐", "vegetable", 1120, "wok"),
    ("Green Beans with Wine", "四季豆", "vegetable", 1120, "wok"),
    # --- 木须 ---
    ("Moo Shi Vegetable", "木须菜", "moo_shi", 1120, "wok"),
    ("Moo Shi Pork", "木须肉", "moo_shi", 1120, "wok"),
    ("Moo Shi Chicken", "木须鸡", "moo_shi", 1120, "wok"),
    ("Moo Shi Beef", "木须牛", "moo_shi", 1120, "wok"),
    ("Moo Shi Shrimp", "木须虾", "moo_shi", 1120, "wok"),
    # --- 芙蓉 ---
    ("Vegetable Egg Foo Young", "什菜芙蓉", "egg_foo_young", 1120, "wok"),
    ("Pork Foo Young", "肉芙蓉", "egg_foo_young", 1120, "wok"),
    ("Chicken Foo Young", "鸡芙蓉", "egg_foo_young", 1120, "wok"),
    ("Shrimp Foo Young", "虾芙蓉", "egg_foo_young", 1214, "wok"),
    ("House Foo Young", "招牌芙蓉", "egg_foo_young", 1214, "wok"),
    # --- 炒米粉 ---
    ("Fried Rice Noodle (Pork/Chicken/Beef/Veg)", "各式炒米粉", "rice_noodle", 1120, "wok"),
    ("Singapore Fried Rice Noodle", "星州炒粉", "rice_noodle", 1120, "wok"),
    ("House Fried Rice Noodle", "本楼炒米粉", "rice_noodle", 1120, "wok"),
    # --- 炒面 ---
    ("Vegetable Chow Mein", "什菜炒面", "chow_mein", 887, "wok"),
    ("Pork Chow Mein", "肉炒面", "chow_mein", 887, "wok"),
    ("Chicken Chow Mein", "鸡炒面", "chow_mein", 887, "wok"),
    ("Beef Chow Mein", "牛炒面", "chow_mein", 887, "wok"),
    ("Shrimp Chow Mein", "虾炒面", "chow_mein", 980, "wok"),
    ("House Chow Mein", "招牌炒面", "chow_mein", 980, "wok"),
    # --- 炒饭 ---
    ("Eggs Fried Rice", "蛋炒饭", "fried_rice", 845, "wok"),
    ("Vegetable Fried Rice", "素菜炒饭", "fried_rice", 845, "wok"),
    ("Pork Fried Rice", "肉丝炒饭", "fried_rice", 845, "wok"),
    ("Chicken Fried Rice", "鸡肉炒饭", "fried_rice", 845, "wok"),
    ("Beef Fried Rice", "牛肉炒饭", "fried_rice", 845, "wok"),
    ("Shrimp Fried Rice", "虾炒饭", "fried_rice", 935, "wok"),
    ("House Fried Rice", "招牌炒饭", "fried_rice", 935, "wok"),
    # --- 套餐 ---
    ("Combination Plate (Serves 1)", "组合餐（1人）", "combo", 1405, "wok"),
    ("Szechuan Dinner (Serves 2)", "四川餐（2人）", "combo", 3735, "wok"),
    ("Szechuan Dinner - Add a Person", "四川餐加人", "combo", 1868, "wok"),
    ("Hong Kong Dinner (Serves 2)", "香港餐（2人）", "combo", 4202, "wok"),
    ("Hong Kong Dinner - Add a Person", "香港餐加人", "combo", 2101, "wok"),
    ("Hunan Dinner (Serves 2)", "湖南餐（2人）", "combo", 4670, "wok"),
    ("Hunan Dinner - Add a Person", "湖南餐加人", "combo", 2335, "wok"),
]

# 分类的显示名与顺序
# (key, 中文, English)。英文名给中英切换用 —— 菜品自己有 name_en，
# 分类以前只有中文，切成英文时这一栏会突兀地留着中文。
CATEGORIES: list[tuple[str, str, str]] = [
    ("lunch_special", "午市特餐", "Lunch Specials"),
    ("chef_special", "厨师特荐", "Chef's Specials"),
    ("appetizer", "开胃菜", "Appetizers"),
    ("soup", "汤", "Soups"),
    ("chicken", "鸡", "Chicken"),
    ("beef", "牛肉", "Beef"),
    ("pork", "猪肉", "Pork"),
    ("seafood", "海鲜", "Seafood"),
    ("vegetable", "蔬菜", "Vegetables"),
    ("moo_shi", "木须", "Moo Shi"),
    ("egg_foo_young", "芙蓉", "Egg Foo Young"),
    ("chow_mein", "炒面", "Chow Mein"),
    ("rice_noodle", "炒米粉", "Rice Noodles"),
    ("fried_rice", "炒饭", "Fried Rice"),
    ("combo", "套餐", "Combos"),
    ("togo", "自提", "To Go"),
]
