import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from .api import auth as auth_api
from .core.deps import CurrentUser, require_role
from .db import get_db
from .schemas import SyncRequest, SyncResponse
from .sync import apply_ops, fetch_changes

app = FastAPI(title="Restaurant System API", version="0.3.0")

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
    applied, duplicate, rejected = apply_ops(db, req.client_id, req.ops, user)
    changes, cursor = fetch_changes(db, req.since_cursor, req.client_id)
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
