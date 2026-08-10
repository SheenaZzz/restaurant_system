# 搭建指南 — 路线图

配套：[DESIGN.md](DESIGN.md)（架构与数据模型） · [DEPLOYMENT.md](DEPLOYMENT.md)（设备与部署）

---

## 我们怎么协作

- **你写代码，我讲设计、给结构、验收。**
- 每一步我会给你：**目标 → 为什么这么设计 → 你要做什么 → 完成标准**
- 你做完跑一下验收命令，把结果贴给我，我们再进下一步
- 卡住了直接说，我给提示而不是直接给答案 —— 因为这个项目的价值在于
  你能在面试里讲清楚每一个决定

> ⚠️ **记工程日志。** 从 Step 1 开始，在 `JOURNAL.md` 里记三样东西：
> ① 每个选型决定（选了什么/否掉什么/为什么）② 每次 benchmark 前后数字
> ③ 每个花了 2 小时以上的 bug（现象/错误假设/怎么定位/根因）。
> **这份日志就是 deep dive 的全部弹药，事后补是编不出来的。**

---

## 路线图

### 第 1–2 周：骨架

| Step | 内容 | 完成标准 |
|---|---|---|
| ~~**0**~~ | ~~环境与仓库~~ ✅ | |
| ~~**1**~~ | ~~Walking Skeleton~~ ✅ | iPad 真机验证通过（HTTP 白屏 / HTTPS 可用） |
| ~~**2**~~ | ~~数据模型落地~~ ✅ | 17 张表；20 桌 + 19 菜品 + 8 价格 + 3 账号 |
| ~~**3**~~ | ~~认证与 RBAC~~ ✅ | `front` 调 admin 端点 → 403（服务端强制） |
| ~~**4**~~ | ~~开桌流程~~ ✅ | 楼面 + 开桌 + 关单，全离线可用；**待你掐表验收 5 秒** |
| **5** | 补菜记录 + 后厨界面 | 单手可点，3 秒完成 |
| **6** | 把离线接到真实业务上 | 飞行模式开 5 桌 + 记 10 条补菜 → 恢复后全部落库无重复 |

### 第 3 周：上线

| Step | 内容 | 完成标准 |
|---|---|---|
| **7** | 店内主机部署 + 域名 + Let's Encrypt | 真实跑一晚市，影子运行 |

### 第 4 周起：业务补全

| Step | 内容 |
|---|---|
| **8** | 日结 Batch（对账差额） |
| **9** | 异常记录（逃单/免单/退菜） |
| **10** | 单点菜品 + Pickup + 后厨队列 + WebSocket |
| **11** | Chaos test + 可观测性埋点 |
| **12** | 老板远程报表 + Cloudflare Tunnel |
| **13** | 消耗率模型 + 备货建议 |

---

## Step 1 为什么是最关键的一步

**Walking Skeleton（行走骨架）** = 一条端到端最小闭环，**不含任何业务逻辑**：

```
iPad 上一个按钮
  → 写 IndexedDB + outbox
  → HTTPS 发到 Caddy
  → FastAPI 幂等写入 Postgres
  → 断网时排队，恢复后重放
```

跑通它，就证明了整套架构成立。跑不通，就要在**写任何业务代码之前**换方案。

**最大的风险点在这里**：iPad Safari 要求 Service Worker 必须 HTTPS，
而店内服务器是内网 IP。这条打不通，离线能力就是零，整个设计要推翻。

> 所以：**先建骨架，再往里长业务。** 不要先写完业务再考虑离线。

---

## 目录结构

```
restaurant_system/
├── DESIGN.md
├── DEPLOYMENT.md
├── GUIDE.md
├── JOURNAL.md          ← 工程日志（Step 1 开始记）
├── .gitignore
├── docker-compose.yml
├── backend/
│   ├── requirements.txt
│   ├── alembic.ini
│   ├── alembic/
│   └── app/
│       ├── __init__.py
│       ├── main.py         FastAPI 入口
│       ├── db.py           连接与 session
│       ├── core/           配置、安全、依赖注入
│       ├── models/         SQLAlchemy 模型
│       └── api/            路由
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── db.ts           Dexie（本地表 + outbox）
│       ├── sync.ts         同步与重放
│       └── pages/
└── ops/
    └── Caddyfile
```
