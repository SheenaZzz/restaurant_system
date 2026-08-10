"""一张账单的完整操作历史。

**不需要额外存任何东西** —— `sync_op` 里本来就有每一条操作的完整 payload，
按 seq 排出来就是这张单的全部经历。当初把它设计成 append-only 的审计日志
（而不是"同步完就能删"的临时队列），回报就在这里。

改单是整体替换，所以"改了什么"需要跟前一个状态比。
比对放在客户端做 —— 服务端只负责把事件按顺序吐出来。
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
             -- 开桌：账单的身份就是那条 op 的 id
             s.op_id::text = :cu
             -- 其它操作都在 payload 里引用账单
             OR s.payload->>'check_uuid' = :cu
             -- 并桌时这张单可能是被并入的一方
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
