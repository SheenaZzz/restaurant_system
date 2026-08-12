"""The full operation history of one check.

**Nothing extra is stored** -- `sync_op` already holds the complete payload of
every operation, and ordering by seq is the whole life of that check. This is
what designing it as an append-only audit log (rather than a queue to empty once synced) pays for.

An edit replaces wholesale, so "what changed" needs comparing against the previous state.
The comparison happens on the client; the server only emits the events in order.
"""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..core.deps import CurrentUser
from ..db import get_db

router = APIRouter(prefix="/api/checks", tags=["history"])


class HistoryOp(BaseModel):
    seq: int
    entity: str
    client_ts: datetime
    user_display: str | None
    payload: dict[str, Any]


_SQL = text(
    """
    SELECT s.seq, s.entity, s.client_ts, s.payload, u.display_name AS user_display
      FROM sync_op s
      LEFT JOIN app_user u ON u.id = s.user_id
     WHERE s.applied_at IS NOT NULL
       AND (
             -- opening a check: the check's identity is that op's id
             s.op_id::text = :cu
             -- every other operation references the check in its payload
             OR s.payload->>'check_uuid' = :cu
             -- on a merge this check may be the one folded in
             OR (
                  jsonb_typeof(s.payload->'source_uuids') = 'array'
                  AND jsonb_exists(s.payload->'source_uuids', :cu)
                )
           )
     ORDER BY s.seq
    """
)


@router.get("/{check_uuid}/history", response_model=list[HistoryOp])
def history(check_uuid: str, user: CurrentUser, db: Session = Depends(get_db)):
    rows = db.execute(_SQL, {"cu": check_uuid}).mappings().all()
    return [HistoryOp(**dict(r)) for r in rows]
