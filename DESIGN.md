# 餐馆运营系统 — 设计文档

小型中餐 buffet 店（20 桌 / 2 位厨师）的堂食 + 自取运营系统。
无外卖、无第三方平台接入、不处理支付。

---

## 1. 业务范围

| 流 | 说明 | 计费实体 |
|---|---|---|
| 堂食 Buffet | 收入 = 人数 × 单价（午/晚市不同价，成人/儿童/长者不同价） | 人头 |
| 堂食点单 | buffet 客人可另点单品 | 菜品 |
| Pickup（电话） | 客人电话下单，到店自取 | 菜品 |

**明确不做**：支付/收款、第三方外卖对接、排班、工资。

### 定位：这是一套「记录系统」，不是收银系统

系统只**计算应收**，不产生付款、不连刷卡机、不打小票收款联。
收款继续走店里现有方式。

这带来三个直接后果：

1. **合规负担归零** —— 不碰 PCI，不存卡号，项目范围可控
2. **`check` 关单只有 `closed`，没有 payment 状态** —— 关单 = 这桌记录完了
3. **「逃单」的定义** = 开了桌、有应收、但没结账就走了 —— 依然可记录、可归因

> 也正因为不收款，日结的**对账差额**（系统应收 vs 卡机/钱箱实收）
> 成了唯一的交叉验证手段 —— 它从「一个功能」变成了**系统正确性的检验器**。

---

## 2. 核心架构决策

### 2.1 服务端跑在店里，不在云上

| 方案 | 断网时 | 结论 |
|---|---|---|
| 云端托管 | 全店瘫痪 | ✗ |
| **店内小主机** | 完全可用 | ✅ 采用 |
| 混合（店内为主 + 云端只读副本） | 可用 | 后期扩展 |

**理由**：所有用户都在同一个 WiFi 下，没有任何订单来源需要外网。把关键路径挂在 ISP 上没有收益。

### 2.2 iPad 端用 PWA，不做原生 App

- 无需 App Store / 无需 $99 开发者账号
- 改完即时生效（迭代期每天可能上线多次）
- 「添加到主屏幕」后全屏运行，员工感知等同原生 App

**代价**：iOS 上无法直接访问 USB/蓝牙 → 打印机必须走网口，由**服务端**驱动（见 4.4）。这反而是更干净的架构。

### 2.3 领域建模成事件流

`tray_event`、`order_line` 等核心实体设计为 append-only，
使得离线冲突在绝大多数路径上**根本不会发生**（见 5.3）。

---

## 3. 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | React + TypeScript + Vite + `vite-plugin-pwa` | 已有 React 基础 |
| 本地存储 | Dexie (IndexedDB) | 管理本地写入 + outbox 队列 |
| 后端 | FastAPI (Python) | 与分析层同语言；自带 OpenAPI → 生成前端 TS 类型 |
| 数据库 | PostgreSQL 16（Docker） | 事务 + JSONB + 并发连接 |
| 实时 | WebSocket（FastAPI 原生） | 20 桌规模不需要消息队列 |
| 反向代理 / TLS | Caddy | 自动 Let's Encrypt + 自动续期 |
| 部署 | Docker Compose，`restart: always` | 店里没有 IT，必须自愈 |
| CI | GitHub Actions：pytest + vitest | |
| 分析/预测 | Python（pandas / scikit-learn / statsmodels），夜间批处理 | 非实时 |

> **不用什么，以及为什么**：不用 Kafka / Redis / K8s / 微服务。
> 峰值一晚约 200 单、10 个并发客户端，单机 Postgres 绰绰有余。
> 引入的每个组件都必须由约束逼出来，否则就是 deep dive 里的攻击面。

---

## 4. 数据模型

### 4.1 菜单与价格

```sql
CREATE TABLE menu_item (
  id             BIGSERIAL PRIMARY KEY,
  name_en        TEXT NOT NULL,
  name_zh        TEXT NOT NULL,
  category       TEXT NOT NULL,          -- appetizer / entree / soup / dessert ...
  price_cents    INT,                    -- buffet 菜可为 NULL
  is_buffet_dish BOOLEAN NOT NULL DEFAULT FALSE,
  station        TEXT,                   -- wok / fryer / cold ...
  active         BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE service_period (
  id            BIGSERIAL PRIMARY KEY,
  business_date DATE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('lunch','dinner')),
  opened_at     TIMESTAMPTZ NOT NULL,
  closed_at     TIMESTAMPTZ,
  UNIQUE (business_date, kind)
);

CREATE TABLE buffet_price (
  id             BIGSERIAL PRIMARY KEY,
  period_kind    TEXT NOT NULL CHECK (period_kind IN ('lunch','dinner')),
  guest_type     TEXT NOT NULL CHECK (guest_type IN ('adult','child','senior')),
  price_cents    INT  NOT NULL,
  effective_from DATE NOT NULL
);
```

### 4.2 桌与账单 —— 两种收入实体挂同一张单

这是本项目最重要的建模点：**一家人吃 buffet + 另点一份海鲜 = 同一个 `check`
下同时挂 `buffet_charge` 和 `order_line`。**

```sql
CREATE TABLE dining_table (
  id    BIGSERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,   -- "A1" ... 共 20 张
  seats INT  NOT NULL,
  zone  TEXT
);

CREATE TABLE "check" (
  id          BIGSERIAL PRIMARY KEY,
  table_id    BIGINT REFERENCES dining_table(id),   -- pickup 时为 NULL
  period_id   BIGINT NOT NULL REFERENCES service_period(id),
  source      TEXT NOT NULL CHECK (source IN ('dine_in','pickup')),
  status      TEXT NOT NULL CHECK (status IN ('open','closed','voided')),
  opened_at   TIMESTAMPTZ NOT NULL,
  closed_at   TIMESTAMPTZ
);

-- 人头计费：buffet 入场费 + 饮料（按人无限续杯）
CREATE TABLE head_charge (
  id               BIGSERIAL PRIMARY KEY,
  check_id         BIGINT NOT NULL REFERENCES "check"(id),
  kind             TEXT   NOT NULL CHECK (kind IN ('admission','drink')),
  guest_type       TEXT   CHECK (guest_type IN ('adult','child','senior')),
  qty              INT    NOT NULL CHECK (qty > 0),
  unit_price_cents INT    NOT NULL,
  -- 入场费必须分成人/儿童/长者；饮料不分
  CONSTRAINT admission_needs_guest_type
    CHECK (kind <> 'admission' OR guest_type IS NOT NULL)
);

-- 单品计费
CREATE TABLE order_line (
  id               BIGSERIAL PRIMARY KEY,
  check_id         BIGINT NOT NULL REFERENCES "check"(id),
  menu_item_id     BIGINT NOT NULL REFERENCES menu_item(id),
  qty              INT    NOT NULL CHECK (qty > 0),
  unit_price_cents INT    NOT NULL,
  notes            TEXT,
  status           TEXT NOT NULL CHECK (status IN ('placed','fired','ready','served','voided')),
  placed_at        TIMESTAMPTZ NOT NULL,
  fired_at         TIMESTAMPTZ,
  ready_at         TIMESTAMPTZ
);
```

> **在座人数不单独存表** —— 从 `check` 的开闭时间 + `head_charge`（kind='admission'）
> 的 qty 推导。少一张表，少一处可能不一致的状态。

### 饮料：按人无限续 → 它是第二项人头费

**已确认：饮料按人收费、无限续杯（如 $2.50/人）。**

所以饮料**不是** `order_line` —— 它跟 buffet 入场费一样是「按人头一次性收」，
只是 kind 不同。这就是为什么表叫 `head_charge` 而不是 `buffet_charge`。

典型的一张桌单：

```
check #1042  table A7  dine_in
├─ head_charge  admission  adult  ×2  @ $16.99    ← 入场费
├─ head_charge  admission  child  ×1  @ $8.99     ← 入场费
├─ head_charge  drink      —      ×3  @ $2.50     ← 饮料，按人无限续
└─ order_line   Crab Rangoon     ×1  @ $6.99      ← 单点，进后厨
```

一桌 3 人全要饮料 → `drink ×3`；只有 2 个人要 → `drink ×2`。
**与实际喝了几杯无关。**

> ⚠️ **饮料数可以超过吃 buffet 的人数。** 陪同的人不吃自助、
> 只要一杯饮料是常见情况（`admission ×2 + drink ×3`）。
>
> 由此产生一个口径问题：`admission` 的人数 = **吃 buffet 的人数**，
> 不等于坐在桌上的人数。后面做消耗率预测时要的正是前者
> （只有吃的人才消耗菜），所以这个口径是对的 ——
> 但如果将来要统计真实上座率，需要另加字段。

### 两个由此产生的推论

1. **饮料杯数 ≠ 消耗量。** 按人收费后，这张表不再包含"喝了多少"的信息。
   若以后要做糖浆/汽水的成本分析，需要另外的数据源（比如按桶记录更换）。
2. **饮料成本随人数而非杯数变化** —— 所以毛利分析要用「饮料人数 / 总客流」这个比率，
   而不是杯数。这个比率本身对老板就有价值（多少比例的客人愿意加钱买饮料）。

### 那 `order_line` 还剩什么

单点菜品（à la carte）和 Pickup 订单。区分是否进后厨用 `menu_item.station`：

```sql
SELECT * FROM order_line ol
  JOIN menu_item mi ON mi.id = ol.menu_item_id
 WHERE mi.station <> 'none';     -- 后厨队列（瓶装饮料/现成甜品 station='none'）
```

> ⚠️ **UI 分组 ≠ 数据库分表。**
> 「开桌时几个人、几杯饮料一起点完」是 **UI 需求** ——
> 开桌页上就是两组大号加减按钮，底层写的是同一张 `head_charge`，两条 kind 不同的行。
> 这一屏是前台**最高频的操作**，速度直接决定系统会不会被真正使用。

### 4.3 Pickup

```sql
CREATE TABLE pickup_order (
  id            BIGSERIAL PRIMARY KEY,
  check_id      BIGINT NOT NULL REFERENCES "check"(id),
  customer_name TEXT,
  phone_last4   CHAR(4),          -- 只存后四位，不存完整号码
  promised_at   TIMESTAMPTZ,      -- 客人说的到店时间
  arrived_at    TIMESTAMPTZ,      -- 实际到店
  picked_up_at  TIMESTAMPTZ,
  status        TEXT NOT NULL
);
```

> **PII 原则：能不收就不收。** 只存手机号后四位用于核对身份，
> 简历和文档里也不要写「存储了 N 个用户手机号」。

### 4.4 Buffet 补菜事件 —— 后续所有预测的唯一数据源

```sql
CREATE TABLE tray_event (
  id           BIGSERIAL PRIMARY KEY,
  menu_item_id BIGINT NOT NULL REFERENCES menu_item(id),
  event_type   TEXT   NOT NULL CHECK (event_type IN ('refill','half','empty','discard')),
  fill_level   REAL,              -- 0.0–1.0，refill/discard 时记录
  observed_at  TIMESTAMPTZ NOT NULL,
  recorded_by  TEXT
);
CREATE INDEX ON tray_event (menu_item_id, observed_at);
```

**这张表是整个项目的技术内核所在**：

> Buffet 的消耗量**不可直接观测**。只有 t₁ 补满、t₂ 发现空了 这样的
> **区间截尾（interval-censored）事件**，而且「发现空了」本身还是延迟的
> —— 服务员不是盯着菜盘的。
>
> 要解决的问题：从这些稀疏、带延迟的离散事件里，反推每道菜的
> **连续消耗速率**，再叠加同期在座人数，做 per-capita 归一化与预测。

### 4.5 同步日志

```sql
CREATE TABLE sync_op (
  op_id       UUID PRIMARY KEY,       -- 客户端生成，幂等键
  client_id   TEXT NOT NULL,
  entity      TEXT NOT NULL,
  op_type     TEXT NOT NULL,
  payload     JSONB NOT NULL,
  client_seq  BIGINT NOT NULL,
  client_ts   TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at  TIMESTAMPTZ
);
```

全量留档 → 任何时刻可回放重建状态，也是审计轨迹。

`sync_op.user_id` 使**每一次操作都可归因到人** —— 这既是审计需要，
也是「谁记录了这条补菜事件」的数据来源。

### 4.6 账号、设备与会话

```sql
CREATE TABLE app_user (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('front','kitchen','admin')),
  password_hash TEXT NOT NULL,              -- argon2id
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 设备只用于同步游标与审计，**不是授权主体**
CREATE TABLE device (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,         -- 'ipad-front-01' / 'ipad-kitchen-01' / 'boss-phone'
  label       TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ                   -- 设备丢失时吊销其上所有会话
);

CREATE TABLE session (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES app_user(id),
  device_id          BIGINT REFERENCES device(id),
  refresh_token_hash TEXT NOT NULL,
  issued_at          TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ
);
```

---

## 4.7 身份与权限设计

### 账号制，不绑定设备

**身份属于账号，不属于设备。** 任何设备打开网页登录后，
按该账号的 role 渲染对应界面 —— 前台 iPad 坏了，随便找台平板登进去就能继续开工。

设备（`client_id`）只用于两件事：同步游标、操作审计。**它不参与授权判断。**

### 两种登录形态

| | 店内员工（front / kitchen） | 老板（admin） |
|---|---|---|
| 网络位置 | 内网 | **公网暴露** |
| 首次登录 | 账号 + 密码 | 账号 + 密码 |
| 会话时长 | **长期**（refresh token，不用每天登） | 短（15 分钟闲置超时） |
| 快速切换 | **PIN 码**（见下） | 无 |
| 二次验证 | 无 | **有**（Cloudflare Access） |

**为什么员工会话必须长期有效**：高峰期在油腻的 iPad 上打密码是不可能被接受的，
强推只会让员工彻底放弃使用这个系统。所以登录一次，refresh token 长期续期。

**快速切换（参考 MenuSifu 的做法）**：前台可能有 2–3 个服务员轮流用同一台设备。
设计成设备记住多个已登录账号，点头像 + **4 位 PIN** 即可切换 ——
PIN 的作用是**操作归属到人**，不是安全边界。这样每条 `sync_op` 都能追到具体是谁做的，
逃单/免单/作废才有意义。

**老板远程**：走 Cloudflare Tunnel + Cloudflare Access（见 DEPLOYMENT.md §6），
应用层再加一层密码。闲置 15 分钟自动登出。

### 离线时认证怎么办（关键）

断网时没有服务器可验证，所以：

1. 客户端凭**缓存的会话**继续本地读写，UI 按缓存的 role 显示
2. 离线期间产生的 op 全部带 `client_id` + `user_id`
3. **授权在 sync 时由服务端强制执行** —— 客户端的角色判断只是 UX，不是安全边界
4. 若会话已被吊销，这批 op 在 sync 时被拒绝并告警

> **这条必须写清楚**：前端的权限控制是给人看的，服务端的才算数。
> 面试里被问到「你的权限怎么防绕过」，这就是答案。

### 权限矩阵

| 操作 | front（前台） | kitchen（后厨） | admin（老板） |
|---|---|---|---|
| 入座登记 / 改人数 | ✅ | ✗ | ✅ |
| 点单 | ✅ | ✗ | ✅ |
| Pickup 订单录入 | ✅ | ✗ | ✅ |
| 查看订单队列 | ✅ | ✅ | ✅ |
| 标记出餐 | ✗ | ✅ | ✅ |
| **补菜事件记录** | ✅ | ✅ | ✅ |
| 结账 / 关单 | ✅ | ✗ | ✅ |
| **记录异常**（逃单/免单/退菜） | ✅ 需填原因 | ✗ | ✅ |
| **异常追认**（超过金额阈值） | ✗ | ✗ | ✅ |
| **日结 batch**（录小费/对账） | ✅ 录入 | ✗ | ✅ 录入 + 确认 |
| 改菜单 / 价格 | ✗ | ✗ | ✅ |
| 看报表 / 导出数据 | ✗ | ✗ | ✅ |
| 账号管理 / 设备吊销 | ✗ | ✗ | ✅ |
| **远程登录** | ✗ | ✗ | ✅ |

设计理由：

- **补菜两端都能记** —— 厨师补菜时顺手点最自然，服务员发现空了也能补记
- **异常前台可记但需填原因** —— 逃单发生在前台，当场不记就永远记不了了；
  但金额超过阈值（比如 $50）要 admin 事后追认
- **日结前台能录、admin 才能确认** —— 录入和确认分离是最基本的内控

---

## 4.8 异常记录（逃单 / 免单 / 退菜）

**这是钱漏掉的地方，也是老板最想看见的东西。**

```sql
CREATE TABLE check_exception (
  id           BIGSERIAL PRIMARY KEY,
  check_id     BIGINT NOT NULL REFERENCES "check"(id),
  kind         TEXT NOT NULL CHECK (kind IN (
                 'walkout',    -- 逃单
                 'comp',       -- 免单（客诉 / 员工餐）
                 'discount',   -- 折扣
                 'void',       -- 退菜（做错 / 客人不要了）
                 'remake',     -- 重做（打翻 / 做坏）
                 'other')),
  amount_cents INT NOT NULL,          -- 涉及金额（系统按当前账单预填）
  reason       TEXT NOT NULL,         -- 必填，不许空
  recorded_by  BIGINT NOT NULL REFERENCES app_user(id),
  recorded_at  TIMESTAMPTZ NOT NULL,
  approved_by  BIGINT REFERENCES app_user(id),   -- 超阈值需 admin 追认
  approved_at  TIMESTAMPTZ
);
CREATE INDEX ON check_exception (recorded_at);
```

**关键设计**：

- **原因必填**，且金额由系统按账单预填而不是手输 —— 减少高峰期的操作负担，也减少乱填
- **可归因到人**（`recorded_by` 来自 PIN 归属）
- **超过阈值（如 $50）需 admin 事后追认** —— 这是最基本的内控。
  异常是唯一能让钱凭空消失的操作路径
- 逃单要能**当场一键记录**：前台发现桌子空了、账没结，点两下就完成，
  否则忙起来就永远不会补记了

---

## 4.9 日结 Batch

参考餐饮 POS 的 "End of Day"。核心不是"算出营业额"，是**对账**：
**系统算出来的应收，和卡机/钱箱里实际的钱，差多少。**

```sql
CREATE TABLE daily_batch (
  id                      BIGSERIAL PRIMARY KEY,
  business_date           DATE NOT NULL UNIQUE,

  -- 系统算出来的
  computed_admission_cents INT NOT NULL,  -- buffet 入场费
  computed_drink_cents     INT NOT NULL,  -- 饮料（按人）
  computed_item_cents      INT NOT NULL,  -- 单点菜品 + pickup
  computed_total_cents     INT NOT NULL,
  guest_adult             INT NOT NULL,
  guest_child             INT NOT NULL,
  guest_senior            INT NOT NULL,
  check_count             INT NOT NULL,
  exception_total_cents   INT NOT NULL,   -- 逃单/免单/折扣合计

  -- 手工录入（来自信用卡机和钱箱 —— 系统不碰支付）
  reported_card_cents       INT,
  reported_card_tips_cents  INT,
  reported_cash_cents       INT,
  reported_cash_tips_cents  INT,

  -- 对账
  variance_cents          INT,            -- 系统应收 vs 实际收，差额
  closed_by               BIGINT REFERENCES app_user(id),
  closed_at               TIMESTAMPTZ,
  approved_by             BIGINT REFERENCES app_user(id),
  note                    TEXT
);
```

**流程（前台晚上 3 分钟点完）**：

1. 系统自动汇总当日：营业额、客流（成人/儿童/长者）、单数、异常合计
2. 前台手工录 4 个数字：卡机总额、卡机小费、现金总额、现金小费
3. **系统算差额并高亮** —— 差额不为零就要说明原因
4. 提交 → admin 远程确认

> **系统不处理支付，所以小费和实收必须手工录入。**
> 这不是缺陷 —— 恰恰是这个"手工录入 vs 系统计算"的**对账差额**，
> 才是日结真正的价值。差额稳定为零说明流程健康，差额飘忽说明有问题。

小费分配（tip pooling / 按工时分摊）**先不做**，只记总额。等家人提出需求再说。

---

## 5. 离线优先与同步协议

### 5.1 不变量

> **断网或断电期间，不丢任何记录、不阻塞任何操作。**

这是全项目唯一的硬约束，也是 chaos test 要证明的东西。

### 5.2 写入路径

```
用户操作
  → 写 IndexedDB（立即，UI 立刻响应）
  → 追加到 outbox（带客户端生成的 op_id UUID）
  → 若在线：立即 POST /sync
  → 若离线：outbox 堆积，恢复后批量重放
```

### 5.3 协议

```http
POST /sync
{
  "client_id": "ipad-front-01",
  "since_cursor": 148213,
  "ops": [
    { "op_id": "0f2c…", "entity": "tray_event", "op_type": "insert",
      "client_seq": 91, "client_ts": "2026-08-08T18:32:11Z",
      "payload": { "menu_item_id": 42, "event_type": "empty", … } }
  ]
}
```

```http
200 OK
{
  "applied":  ["0f2c…"],
  "rejected": [],
  "cursor":   148260,
  "changes":  [ … 自 since_cursor 以来其它客户端的变更 … ]
}
```

服务端处理每个 op：

```sql
INSERT INTO sync_op (op_id, …) VALUES (…) ON CONFLICT (op_id) DO NOTHING;
-- 仅当真正插入时才执行业务逻辑 → 天然幂等，重试安全
```

### 5.4 冲突策略

| 实体 | 可变？ | 冲突处理 |
|---|---|---|
| `tray_event` | append-only | **不可能冲突** |
| `order_line`（新增） | append-only | **不可能冲突** |
| `order_line.status` | 可变 | 状态机单调推进（placed→fired→ready→served），只接受前进 |
| `check.status` | 可变 | 服务端接收时序 LWW |
| `buffet_charge.qty` | 可变 | 服务端接收时序 LWW + `sync_op` 留档可回溯 |

> **核心论点**：把领域建模成事件流之后，绝大多数路径根本不产生冲突。
> 真正需要冲突策略的只有极少数可变状态。

---

## 6. 界面（按角色，不按设备）

登录后按 `role` 渲染，同一份代码、同一个网址。
前台 iPad 坏了随便找台设备登进去就能继续开工。

### `front` 服务员看到的

| 页面 | 核心要求 |
|---|---|
| **桌面总览** | 20 桌状态一屏可见，颜色区分：空 / 在座 / 待结 / 异常 |
| **开桌（buffet）** | 成人/儿童/长者 **+ 饮料杯数**，两组大号加减按钮，**三下点完** |
| 点单（à la carte） | 中英双语菜名，挂到同一张 check |
| Pickup 订单 | 替代纸条；记录承诺时间 vs 实际到店 |
| 补菜（次要入口） | 发现菜盘空了可补记 |
| **异常记录** | 逃单 / 免单 / 退菜 —— 长按桌位即可发起，金额自动预填，原因必填 |
| 结账 / 关单 | 只关单，**不处理收款** |
| **日结 Batch** | 系统汇总 + 手工录 4 个数字 + 差额高亮，3 分钟点完 |

### `kitchen` 后厨看到的

| 页面 | 核心要求 |
|---|---|
| 订单队列 | 只读 + 标记出餐；字要大，隔一米看得清 |
| **补菜记录** | 补 / 半 / 空 三个大按钮，**单手可点**（厨师补菜时顺手） |

> 后厨 iPad 一机两用。补菜由厨师记录其实比专设一台 buffet 台 iPad 更合理
> —— 补菜本来就是厨师做的动作。
>
> ⚠️ 「订单队列」这一页是**第一个要验证的**：2 个厨师的小厨房里，
> 服务员走五步喊一声可能更快。上线两周看真实查看量，没人用就砍掉，
> 只留补菜记录。

### `admin` 老板看到的（可远程）

`front` 的全部，外加：日结确认与对账差额、异常追认、营业额与客流曲线、
浪费估算、备货建议、菜单价格管理、账号管理、数据导出。

手机浏览器打开即可，**不需要装 App**（见 DEPLOYMENT.md §6）。

---

### 参考 MenuSifu 的正确姿势

MenuSifu 是美国中餐馆 POS 的事实标准之一，家里人多半熟悉它的操作习惯。
**值得抄的是操作流程和信息密度**（几下点完一桌、桌面总览怎么排、日结长什么样），
让家人当面演示一遍他们最常用的几个动作，比看截图有用得多。

**不要抄的**：它是完整 POS（含支付、含刷卡机、含硬件生态）。
我们做的是**运营层**，明确不碰支付。别试图 1:1 复刻，会做不完。

**UX 硬约束（真实的，不是假想的）**：使用者可能是中老年、中英文混用、
高峰期只有 3 秒操作时间、可能端着盘子腾不出手。按钮要大、层级要浅、
误触要可撤销。

---

## 7. 分析与预测（第二阶段）

### 7.1 目标

不是实时提示，是**每周一份备货建议 + 浪费估算**。批处理，不是在线服务。

### 7.2 方法

1. 从 `tray_event` 的区间截尾事件估计每道菜消耗速率 λ(t)
2. 用同期在座人数做 per-capita 归一化
3. 按时段（午/晚）× 星期分层
4. 预测次日/次周各菜用量

### 7.3 评估纪律（重要）

**必须跟 baseline 严格对比**，baseline = 「照抄上周同一时段」。
指标用 MAE，做正经的时序交叉验证（不能用未来数据）。

> ⚠️ 提前说明：在这个数据量下，**模型很可能赢不过 baseline**。
> 那不是失败。正确的结论是：「做了正经评估，发现赢不过，
> 所以上线的是 baseline + 异常偏离提醒」。
> 这是成熟的工程判断，前提是真的量了。

---

## 8. 交付顺序（8–10 周，第 3 周店里见）

| 周 | 内容 |
|---|---|
| 1 | 数据模型 + FastAPI 骨架 + 登录/RBAC + Docker Compose + CI；店内主机装好 |
| 2 | PWA 骨架 + **HTTPS 证书链路打通**（先啃这个坑）+ 桌面总览 + 开桌页 + 补菜页 |
| **3** | **上线这三屏，影子运行 —— 数据钟开始走** |
| **4** | **日结 Batch**（见下：提前做）+ 异常记录 | 
| 5–6 | 单点菜品 + Pickup + 后厨队列 + WebSocket 推送 |
| 7–8 | 离线优先完整实现 + chaos test（拔网线、拔电源）+ 可观测性埋点 |
| 9 | 老板远程报表 + Cloudflare Tunnel + 夜间备份 + 运维加固 |
| 10+ | 消耗率模型 + 备货建议，跟 baseline 严格对比 |

**两个顺序上的理由：**

- **补菜采集必须在第 3 周就上线** —— 消耗率模型需要 4–6 周数据才有得做，
  这是整条关键路径上最早需要启动的一环
- **日结提前到第 4 周** —— 老板现在每晚手工加总，这是痛感最明确、
  见效最快的功能；而且它逼着前台数据必须录全，天然驱动采用率

---

## 9. 必须提前量的基线（上线后永久拿不到）

1. 各 buffet 菜盘平均多久空一次、一天补几次（纸笔记一周即可）
2. 一天倒掉多少（粗估「几盘」也行）
3. Pickup：客人说的到店时间 vs 实际到店时间，**差多少**
4. 菜出锅到被取走平均放多久
5. 晚市高峰每小时多少单、buffet 每小时入座多少人
6. 一晚上漏单/错单几次

第 1、2、3 条最重要 —— 这是最终成果里所有数字的唯一来源。

---

## 10. 风险

| 风险 | 应对 |
|---|---|
| **⚠️ 双重录入**（最大的落地风险） | 若店里已有 POS 在收款，服务员要在两套系统各录一遍 → 必然放弃使用。见下 |
| **家人出于人情说"挺好的"然后继续用老办法** | 别信评价，看使用数据。上线两周查日均点击量；没人用就去店里站一晚看为什么 |
| 高峰期系统出问题影响真实营业 | 前 2–3 周**影子运行**，绝不先拆掉能用的流程 |
| 数据丢失 | 夜间备份 + 本地副本 + 云端副本（见 DEPLOYMENT.md） |
| 范围爆炸做不完 | 严格按第 8 节顺序；砍功能不砍约束 |

### 现状已确认：无 POS，手工记账，只有刷卡机

**双重录入风险解除** —— 没有存量系统要对接，你的系统就是**唯一的主记录**。
这是最理想的情况，但也带来三条硬性后果：

| 后果 | 含义 |
|---|---|
| **数据丢失 = 当天的账没了** | 可靠性从"nice to have"变成硬需求。备份、崩溃恢复、离线队列都不是加分项而是底线 |
| **必须比纸笔快** | 手工划几笔是很快的。开桌流程若超过 5 秒，一定会被弃用。这是采用率的唯一门槛 |
| **没有历史数据** | 想做"上线前后对比"，要么现在开始手工记基线，要么把过去几周的账本手工补录 |

**同时也解锁了两件之前做不到的事**：

- 店里**从来没有过菜品销量数据** —— 哪些菜好卖、哪些菜常年没人点，
  这本身对老板就有即时价值
- 老板现在每晚**手工加总**营业额 —— 日结自动化是**最容易被感激、最容易量化价值**
  的功能（直接量"省了多少分钟"）

> 💡 因此**日结要提前做**，不能排在第 8 周。它每天必做、痛感明确、见效最快，
> 而且它逼着前台数据必须录全（否则日结不准）—— 天然驱动采用率。

---

相关文档：[DEPLOYMENT.md](DEPLOYMENT.md) — 设备清单、网络拓扑、证书链路、故障恢复
