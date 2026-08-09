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

**重建数据库**（改了 `db/init/*.sql` 必须这样，因为初始化脚本只在卷为空时跑）：

```bash
docker compose down -v && docker compose up -d --build
```

> ⚠️ `-v` 会删掉数据卷。Step 7 上线之后**绝对不要**对生产执行。

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

```bash
cd frontend && npm run build && cd ..
docker compose --profile lan up -d
```

1. 改 `ops/Caddyfile`，把 `192.168.1.10` 换成本机局域网 IP
   （`ipconfig` 看 IPv4；本机当前为 `192.168.1.148`）
2. 导出 Caddy 根证书并装到 iPad：
   ```bash
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./root.crt
   ```
   传到 iPad → 设置 → 通用 → VPN与设备管理 → 安装描述文件
   → **再去 设置 → 通用 → 关于本机 → 证书信任设置 打开开关**（这步最容易漏）
3. Safari 打开 `https://<局域网IP>` → 分享 → 添加到主屏幕
4. 从主屏幕图标进入 → 开飞行模式 → 点 10 次 → 关飞行模式 → 核对计数

> 买了域名之后换成 Caddyfile 里的生产块（Let's Encrypt DNS-01），
> iPad 就不需要装任何证书了。

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| `docker: command not found` | Docker Desktop 是用户级安装；**开个新终端**让 PATH 生效 |
| API 起不来，日志报连不上 db | 正常重试中；`depends_on: service_healthy` 会等 healthcheck |
| 改了 `db/init/*.sql` 不生效 | 初始化脚本只在空卷时执行 → `docker compose down -v` |
| iPad 上 Service Worker 不注册 | 必须 HTTPS；且根证书要在「证书信任设置」里额外打开 |
| iPad 装到主屏幕后数据没了 | 主屏幕 App 与 Safari **存储隔离** → 先装再用 |
