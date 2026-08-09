# 工程日志

> **每天记，事后补是编不出来的。** 这份日志是 deep dive 的全部弹药 ——
> 面试里最强的回答永远是「我量到了 X，所以改成了 Y，结果变成 Z」。

三类条目，按需记：

- **决策** — 选了什么 / 否掉了什么 / 为什么 / 代价
- **测量** — 改动前后的具体数字
- **故障** — 现象 / 我的错误假设 / 怎么定位 / 根因

---

## 2026-08-08 — Step 0 环境搭建

**决策：项目移出 OneDrive 同步目录**
- 选了 `C:\Users\Welcome\dev\restaurant_system`，否掉了 `Desktop`（OneDrive 同步）
- 原因：`node_modules` 有数万个小文件，OneDrive 实时同步会拖慢构建、锁文件、偶发损坏；
  `.gitignore` 管不了 OneDrive
- 代价：不再自动云备份 → 靠 git remote 兜底

**决策：Docker Desktop 而非原生 Postgres**
- 原因：生产环境（店内 Ubuntu 主机）用 Docker Compose，本地保持一致，避免"我本地能跑"
- 代价：Windows 上要走 WSL2，安装较重

**故障：以为 Docker 装失败了**
- 现象：`C:\Program Files\Docker` 不存在，`docker` 命令 not found
- 错误假设：安装器失败了
- 定位：读 `%LOCALAPPDATA%\Docker\install-log.txt`，末行是 `Installation succeeded`
- 根因：Docker Desktop 4.85 默认改为**用户级安装**，装到
  `%LOCALAPPDATA%\Programs\DockerDesktop`；且 PATH 变更不会作用于已打开的终端
- 教训：**先读安装日志再下结论**

---

## 2026-08-08 — Step 1 Walking Skeleton

**决策：先建骨架，不先写业务**
- 选了「一条不含业务逻辑的端到端最小闭环」，否掉了「先做开桌页再补离线」
- 原因：iPad Safari 要求 Service Worker 必须 HTTPS，而店内服务器是内网 IP。
  这条打不通，离线能力就是零，整个架构要推翻 —— 必须在写业务代码**之前**验证
- 代价：多花两天，产出的 `ping_event` 表 Step 2 就会被删掉

**决策：幂等靠数据库主键，不靠应用层查重**
- 选了 `INSERT ... ON CONFLICT (op_id) DO NOTHING RETURNING op_id`
- 否掉了「先 SELECT 查在不在，再 INSERT」—— 那是 TOCTOU 竞态，
  两个并发请求会双双查到"不存在"然后都插入
- 代价：业务副作用的判断依赖 RETURNING 是否有行，可读性略差

**决策：sync_op 写入与业务副作用必须同事务**
- 否掉了「先记 sync_op，再单独提交业务写入」
- 原因：崩在中间会留下"记了但没生效"的洞，而重放又会被幂等判断跳过 →
  数据永久少一条，且**无法察觉**
- 这是整个离线架构里最危险的一个点

**决策：单条失败用 SAVEPOINT 隔离**
- 一条坏 op 不能拖垮整批。前台离线两小时攒了 200 条，
  不能因为第 3 条格式错误就全部退回

**测量（Step 1 验收）**
- 在线点 3 次 → 立即落库，计数 3→6
- 停 API 容器 → 点 10 次 → outbox=10，本地镜像=16，UI「待同步 10」
- 起 API → 重放 → **16/16/16，distinct_op=16，零重复**
- 强制重发 3 条已应用的 op → `applied:0 duplicate:3`，计数仍是 16
- 电脑休眠 35 分钟后容器自动恢复，数据完整（命名卷有效）

**故障：TS 把 `crypto` 收窄成 `never`**
- 现象：`tsc` 报 `Property 'getRandomValues' does not exist on type 'never'`
- 错误假设：以为是 `@types/node` 和 lib.dom 冲突
- 定位：`'randomUUID' in crypto` 这个 `in` 收窄，让 TS 认为 else 分支不可达
- 根因：lib.dom 把 `crypto` 声明为必然存在且必然有 `randomUUID`
- 处理：显式 `globalThis.crypto as Crypto | undefined` 放宽类型
- **顺带发现的真问题**：`crypto.randomUUID` 只在安全上下文可用 ——
  iPad 走明文 HTTP 时它是 undefined。又一个"必须上 HTTPS"的理由

**故障：状态栏残留"同步失败"**
- 现象：outbox 已清零（说明同步成功），状态栏却still显示失败
- 根因：「立即同步」按钮没走 `report` 回调，显示的是上一次自动触发的结果
- 处理：手动和自动共用同一个上报路径
- 教训：**离线系统里"骗人的状态显示"比崩溃更危险** ——
  员工会以为没同步而重复操作

---

## 2026-08-09 — iPad 真机测试暴露的三个问题

**测量：HTTP / HTTPS 对照实验（在同一台 iPad 上）**

| | HTTP `:8080` | HTTPS |
|---|---|---|
| 断网后从主屏幕重开 | **一片空白** | **正常进入，可继续操作** |

结论：Service Worker 需要安全上下文；没有它，离线时连界面都加载不出来，
IndexedDB 里的数据再完整也没用 —— 员工走不到那个按钮。

---

### 故障 A（最严重）：4 条记录永久卡在 outbox，且不报任何错

- **现象**：UI 显示「待同步 4」，但一直不减少；点「立即同步」也没反应
- **错误假设**：以为是网络问题、或者服务端拒绝了
- **定位过程**：
  1. 查数据库 —— 这 4 个 op_id **根本不存在**
  2. 查 API 日志 —— 从未出现过这些 id，也没有任何 rejected/422，全是 200
  3. 查 Caddy 访问日志 —— 请求体一直是 **55 字节**，即 `ops: []`
  4. 矛盾点锁定：**`count()` 说有 4 条，取数却取出 0 条**
- **根因**：

  ```ts
  db.outbox.orderBy('client_seq')   // ← 索引查询
  ```

  IndexedDB 会把**索引键无效**（NaN / undefined / null）的记录
  **静默排除**在索引查询结果之外，但 `count()` 照数不误。
  于是记录：① 存进去了 ② 被计数了 ③ 却永远取不出来发不出去。

  更糟的是 `client_seq` 一旦变成 `NaN`，`NaN + 1` 仍是 `NaN`，
  **之后每一条新记录都会中招**。

- **处理**：
  - `takePending()` 改为 `toArray()` + JS 排序，**不依赖索引**
  - 启动时自愈：把 `client_seq` 无效的历史记录补成合法值
  - `nextClientSeq()` 做 NaN 防护
- **教训**：**在离线系统里，"静默丢失"比崩溃危险得多。**
  崩溃你会立刻发现，静默丢失要等到月底对账才发现少了一单。
  凡是"计数"和"取数"走两条不同路径的地方，都要怀疑它们会不一致。

### 故障 B：离线被显示成"同步失败"

- 断网时 `fetch` 抛错 → UI 显示「同步失败（离线？）」
- 但离线**不是失败**，是正常排队。服务员看到"失败"会**重复操作**
- 处理：区分 `offline` / `error` 两种性质，配色也区分
- **教训**：骗人的状态提示比崩溃更危险

### 故障 C：跨设备变更的时间戳是错的

- `changes` 下发时不带 `client_ts`，接收端只能 `new Date()` 兜底
- 结果：离线积压两小时的记录，到了别的设备上全被打上「刚刚」
- 处理：服务端在 `ChangeOut` 里带上 `client_ts`

### 顺带修的设计缺口：死信队列

被服务端拒绝的 op 原本会留在 outbox 里**无限重试**，
"待同步"永远不归零。现在移进 `deadletter` 表，
UI 上以红色「失败 N」徽章暴露 —— **看不见的失败等于丢单**。

---

## 2026-08-09 — 局域网 HTTPS：SNI 不能填 IP

- **现象**：`https://192.168.1.148` TLS 握手直接失败
  （curl 报 `SEC_E_ILLEGAL_MESSAGE`）
- **根因**：RFC 6066 规定 SNI 只能是**主机名**，不能是 IP 字面量。
  用 IP 访问时客户端不发 SNI → Caddy 匹配不到站点 → 拒绝握手
- **处理**：改用 mDNS 主机名 `sheena.local`（iOS 原生支持，
  Windows 10+ 自带响应器），额外好处是不受 DHCP 换 IP 影响
- **决策影响**：这直接强化了生产环境**买域名**而不是用裸 IP 的理由

---

## 模板

```
## YYYY-MM-DD — Step N 主题

**决策：**
- 选了 / 否掉了 / 为什么 / 代价

**测量：**
- 指标：改前 → 改后

**故障：**
- 现象 / 错误假设 / 定位过程 / 根因
```
