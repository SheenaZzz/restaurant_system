# 运行手册

## 首次准备

```bash
cp .env.example .env          # 改掉 POSTGRES_PASSWORD
cd frontend && npm install && cd ..
```

## 日常开发（两个终端）

```bash
# 终端 1：数据库 + 后端
docker compose up -d --build
docker compose logs -f api

# 终端 2：前端
cd frontend && npm run dev
```

- 前端 http://localhost:5173
- 后端 http://localhost:8000 · 文档 http://localhost:8000/docs
- 前端只调 `/api/*`，由 Vite 代理到后端 → **开发和生产的请求路径完全一致**

## 常用命令

```bash
docker compose ps                       # 状态
docker compose logs -f api              # 后端日志
docker compose restart api              # 重启后端
docker compose exec db psql -U restaurant -d restaurant   # 进数据库
```

## 数据库迁移（Alembic）

schema 的单一事实来源是 `backend/app/models.py`。改完模型后：

```bash
docker compose run --rm --no-deps -v "$PWD/backend/alembic/versions:/app/alembic/versions" -e DATABASE_URL="postgresql+psycopg://restaurant:change_me_local_dev@db:5432/restaurant" api alembic revision --autogenerate -m "描述"
```

⚠️ **两个必踩的坑**：

1. **必须挂载 `versions` 目录**，否则生成的迁移文件留在容器里，`--rm` 一删就没了
2. **生成后必须 `docker compose build api` 再重启** —— 迁移文件是 `COPY` 进镜像的，
   旧镜像里没有新迁移，`alembic upgrade head` 会**静默什么都不做**（日志里没有
   `Running upgrade` 那一行就是这个情况）

应用迁移：容器启动时 `entrypoint.sh` 自动跑 `alembic upgrade head`，无需手动。

```bash
docker compose build api && docker compose up -d api
docker compose exec api python -m app.seed      # 种子数据，幂等
docker compose exec api alembic current         # 当前版本
docker compose exec api alembic history         # 迁移历史
```

**彻底重建数据库**：

```bash
docker compose down -v && docker compose up -d --build
```

> ⚠️ `-v` 会删掉所有**命名卷**（数据库数据）。Step 7 上线之后**绝对不要**对生产执行。
>
> 本地 CA 已改为绑定挂载在 `ops/caddy-data/`，**不受 `-v` 影响** ——
> 所以 iPad 上装过的根证书一直有效，不用反复重装。
> 这个目录里有 CA **私钥**，已在 `.gitignore` 排除，绝不能提交。

## 验收测试（Step 1）

```bash
# 1. 健康检查
curl -s localhost:8000/api/health

# 2. 幂等：同一批发两次，第二次全部 duplicate，计数不变
BODY='{"client_id":"t1","since_cursor":0,"ops":[{"op_id":"11111111-1111-4111-8111-111111111111","entity":"ping_event","op_type":"insert","client_seq":1,"client_ts":"2026-01-01T00:00:00Z","payload":{"label":"A"}}]}'
curl -s -X POST localhost:8000/api/sync -H 'Content-Type: application/json' -d "$BODY"
curl -s -X POST localhost:8000/api/sync -H 'Content-Type: application/json' -d "$BODY"
curl -s localhost:8000/api/debug/count

# 3. 离线重放：停 API → 在页面点 N 次 → 起 API → 点"立即同步"
docker compose stop api
docker compose start api
```

浏览器里核对：`待同步` 归零，且 `debug/count` 恰好增加 N，无重复。

## iPad 真机测试

### 电脑侧（一条命令）

```bash
cd frontend && npm run build && cd .. && docker compose --profile lan up -d
```

起来后两个入口：

| 入口 | 用途 |
|---|---|
| `https://sheena.local` | 正式站点，Service Worker 能注册 |
| `http://sheena.local:8080` | **对照组**，明文，SW 注册不了 |

> ⚠️ **用主机名而不是 IP。** 用 IP 访问 HTTPS 时客户端不发送 SNI
> （RFC 6066 规定 SNI 只能是主机名），Caddy 匹配不到站点会直接拒绝握手。
> `sheena.local` 走 mDNS，iOS 原生支持，还不受 DHCP 换 IP 影响。
>
> 换机器要改 `ops/Caddyfile` 里的主机名（`hostname` 命令可查）。

### iPad 侧

**1. 装根证书**（只需一次）

Safari 打开 `http://sheena.local:8080/root.crt` → 提示"已下载描述文件"

- 设置 → 通用 → VPN与设备管理 → 安装
- **⚠️ 再去 设置 → 通用 → 关于本机 → 证书信任设置 → 打开开关**
  （最容易漏的一步；少了它证书不被信任，SW 仍然注册不了）

**2. 对照实验 —— 这才是重点**

| 步骤 | HTTP（`:8080`） | HTTPS |
|---|---|---|
| ① Safari 打开，分享 → 添加到主屏幕 | ✅ | ✅ |
| ② 从主屏幕图标进入，点几次「记录一次」 | ✅ | ✅ |
| ③ **完全退出 App**（上划关闭） | | |
| ④ 开飞行模式 | | |
| ⑤ 再点主屏幕图标 | ❌ **一片空白** | ✅ **正常进入** |
| ⑥ 继续点「记录一次」 | 进不去 | ✅ 排队，显示「待同步 N」 |
| ⑦ 关飞行模式 → 自动重放 | | ✅ 归零 |

> ⚠️ 两个站点要用**不同的主屏幕图标**分别测；
> iOS 里主屏幕 App 和 Safari 的存储是隔离的，且不同来源互不共享。

**3. 核对数据**

```bash
curl -s localhost:8000/api/debug/count
```

三个数应相等，且恰好等于总点击次数（含之前的 16）。

> 买了域名之后换成 Caddyfile 里的生产块（Let's Encrypt DNS-01），
> iPad 就不需要装任何证书了。

## 账号（开发用）

| 账号 | 角色 | 密码 | PIN |
|---|---|---|---|
| `front` | front | `front-dev-pw` | 1111 |
| `kitchen` | kitchen | `kitchen-dev-pw` | 2222 |
| `admin` | admin | `admin-dev-pw` | — |

⚠️ 上线前必须改成每人独立的强密码，并把 `.env` 里的 `JWT_SECRET` 换成随机值：

```bash
python -c "import secrets;print(secrets.token_urlsafe(48))"
```

会话时长按角色区分：员工 30 天（高峰期不可能让人反复打密码），
admin 12 小时（走公网暴露的入口，寿命必须短）。

## 验收测试（Step 3 认证）

```bash
# 未认证访问 sync → 401
curl -s -o /dev/null -w "%{http_code}
" -X POST localhost:8000/api/sync -H 'Content-Type: application/json' -d '{"client_id":"x","since_cursor":0,"ops":[]}'

# front 登录后调 admin 端点 → 403
FT=$(curl -s -X POST localhost:8000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"front","password":"front-dev-pw","client_id":"t"}' | python -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -o /dev/null -w "%{http_code}
" localhost:8000/api/admin/summary -H "Authorization: Bearer $FT"
```

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| `docker: command not found` | Docker Desktop 是用户级安装；**开个新终端**让 PATH 生效 |
| API 起不来，日志报连不上 db | 正常重试中；`depends_on: service_healthy` 会等 healthcheck |
| 改了模型但 schema 没变 | 生成迁移后必须 `docker compose build api`，迁移是 COPY 进镜像的 |
| iPad 上装了多张同名 Caddy 证书 | 名字都是 `Caddy Local Authority - 2026 ECC Root`，肉眼分不出。**全删掉重装一张**即可，旧 CA 私钥已不存在 |
| iPad 上 Service Worker 不注册 | 必须 HTTPS；且根证书要在「证书信任设置」里额外打开 |
| iPad 装到主屏幕后数据没了 | 主屏幕 App 与 Safari **存储隔离** → 先装再用 |
