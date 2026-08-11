import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from .api import admin as admin_api
from .api import auth as auth_api
from .api import catalog as catalog_api
from .api import history as history_api
from .api import reports as reports_api
from .core.deps import CurrentUser, require_role
from .db import get_db
from .schemas import SyncRequest, SyncResponse
from .sync import apply_ops, fetch_changes, log_truncated

app = FastAPI(title="Restaurant System API", version="0.5.0")

# 开发期前端在 :5173、后端在 :8000，跨源。
# 生产两者都在 Caddy 后面同源，这段不会生效。
_origins = [o for o in os.getenv("CORS_ORIGINS", "").split(",") if o]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(auth_api.router)
app.include_router(catalog_api.router)
app.include_router(reports_api.router)
app.include_router(history_api.router)
app.include_router(admin_api.router)


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    """存活探针。真的打一次库，而不是只回 200 ——
    "进程活着但连不上数据库" 正是最需要被发现的状态。

    刻意不要求认证：探针必须在没有凭证时也能用。"""
    db.execute(text("SELECT 1"))
    return {"status": "ok", "db": "ok"}


@app.post("/api/sync", response_model=SyncResponse)
def sync(req: SyncRequest, user: CurrentUser, db: Session = Depends(get_db)):
    """离线队列的唯一入口。

    ⚠️ **授权在这里强制执行，不在前端。**
    客户端离线期间产生的每条 op 都带 client_id，但**不带角色声明** ——
    角色只从服务端验过的 access token 里取。前端把 role 改成 admin
    也没用，写入路径看的是这里的 `user`。
    """
    # ⚠️ 截断判定必须在 apply_ops **之前**：这一批 op 会写进日志、把
    #    MAX(seq) 顶上去，先写再判就永远判不出来。
    truncated = log_truncated(db, req.since_cursor)

    # 即使要求客户端重来，也照样先收下它带来的 op ——
    # outbox 里可能是断网期间真实录的单，那是店里的钱，不能因为重置丢掉。
    applied, duplicate, rejected = apply_ops(db, req.client_id, req.ops, user)

    if truncated:
        return SyncResponse(
            applied=applied,
            duplicate=duplicate,
            rejected=rejected,
            # 游标归零，客户端清空镜像后带 resync=True 整份重拉
            cursor=0,
            changes=[],
            reset=True,
        )

    changes, cursor = fetch_changes(
        db, req.since_cursor, req.client_id, resync=req.resync
    )
    return SyncResponse(
        applied=applied,
        duplicate=duplicate,
        rejected=rejected,
        cursor=cursor,
        changes=changes,
    )


@app.get("/api/admin/summary", dependencies=[Depends(require_role("admin"))])
def admin_summary(db: Session = Depends(get_db)):
    """仅 admin。Step 3 的验收探针，也是 Step 12 老板报表的雏形。"""
    row = db.execute(
        text(
            """
            SELECT (SELECT count(*) FROM dining_table)  AS tables,
                   (SELECT count(*) FROM menu_item)     AS menu_items,
                   (SELECT count(*) FROM app_user)      AS users,
                   (SELECT count(*) FROM sync_op)       AS sync_ops
            """
        )
    ).mappings().one()
    return dict(row)


@app.get("/api/debug/count")
def debug_count(user: CurrentUser, db: Session = Depends(get_db)):
    """骨架验收用。Step 4 之后删掉。"""
    ops = db.execute(text("SELECT count(*) FROM sync_op")).scalar_one()
    applied = db.execute(
        text("SELECT count(*) FROM sync_op WHERE applied_at IS NOT NULL")
    ).scalar_one()
    events = db.execute(text("SELECT count(*) FROM ping_event")).scalar_one()
    return {"sync_op": ops, "applied": applied, "ping_event": events, "as": user.username}
