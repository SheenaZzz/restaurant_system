import os

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.orm import Session

from .db import get_db
from .schemas import SyncRequest, SyncResponse
from .sync import apply_ops, fetch_changes

app = FastAPI(title="Restaurant System API", version="0.1.0")

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


@app.get("/api/health")
def health(db: Session = Depends(get_db)):
    """存活探针。真的打一次库，而不是只回 200 ——
    "进程活着但连不上数据库" 正是最需要被发现的状态。"""
    db.execute(text("SELECT 1"))
    return {"status": "ok", "db": "ok"}


@app.post("/api/sync", response_model=SyncResponse)
def sync(req: SyncRequest, db: Session = Depends(get_db)):
    applied, duplicate, rejected = apply_ops(db, req.client_id, req.ops)
    changes, cursor = fetch_changes(db, req.since_cursor, req.client_id)
    return SyncResponse(
        applied=applied,
        duplicate=duplicate,
        rejected=rejected,
        cursor=cursor,
        changes=changes,
    )


@app.get("/api/debug/count")
def debug_count(db: Session = Depends(get_db)):
    """骨架验收用：直接读计数，方便对拍。Step 2 之后删掉。"""
    ops = db.execute(text("SELECT count(*) FROM sync_op")).scalar_one()
    applied = db.execute(
        text("SELECT count(*) FROM sync_op WHERE applied_at IS NOT NULL")
    ).scalar_one()
    events = db.execute(text("SELECT count(*) FROM ping_event")).scalar_one()
    return {"sync_op": ops, "applied": applied, "ping_event": events}
