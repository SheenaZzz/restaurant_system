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

# In development the front end is on :5173 and the API on :8000, so requests cross origins.
# In production both sit behind Caddy on one origin and this does nothing.
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
    """Liveness probe. It really touches the database rather than just
    returning 200 -- "the process is up but cannot reach the database" is
    exactly the state worth catching.

    Deliberately unauthenticated: a probe has to work without credentials."""
    db.execute(text("SELECT 1"))
    return {"status": "ok", "db": "ok"}


@app.post("/api/sync", response_model=SyncResponse)
def sync(req: SyncRequest, user: CurrentUser, db: Session = Depends(get_db)):
    """The one entry point for the offline queue.

    ⚠️ **Authorisation is enforced here, not in the front end.**
    Every op a client produced offline carries a client_id but **no role
    claim** -- the role comes only from the access token the server verified.
    Setting role to admin in the front end changes nothing; the write path
    reads the `user` here.
    """
    # ⚠️ The truncation test has to run **before** apply_ops: this batch is
    #    about to push MAX(seq) past the cursor, and testing afterwards could never detect it.
    truncated = log_truncated(db, req.since_cursor)

    # Take the client's ops even when telling it to start over -- the outbox
    # may hold checks really entered while the network was down, which is the store's money.
    applied, duplicate, rejected = apply_ops(db, req.client_id, req.ops, user)

    if truncated:
        return SyncResponse(
            applied=applied,
            duplicate=duplicate,
            rejected=rejected,
            # Cursor to zero; the client empties its mirror and re-pulls with resync=True
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
    """admin only. The Step 3 acceptance probe, and the seed of the owner's report in Step 12."""
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
    """Skeleton acceptance only. Removed after Step 4."""
    ops = db.execute(text("SELECT count(*) FROM sync_op")).scalar_one()
    applied = db.execute(
        text("SELECT count(*) FROM sync_op WHERE applied_at IS NOT NULL")
    ).scalar_one()
    events = db.execute(text("SELECT count(*) FROM ping_event")).scalar_one()
    return {"sync_op": ops, "applied": applied, "ping_event": events, "as": user.username}
