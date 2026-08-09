"""同步核心：幂等接收 + 增量下发。

整个离线优先架构的正确性都压在这个文件上，所以逻辑刻意写得很直白。

不变量
------
1. 同一个 op_id 无论重放多少次，业务副作用只发生一次。
2. "记录 sync_op" 和 "产生业务副作用" 要么都成功、要么都不发生
   —— 二者必须在同一个事务里。否则崩溃在中间会留下
   "记了但没生效" 的洞，而重放又会被幂等判断跳过，数据就永久少了一条。
3. 一条 op 失败不能拖垮整批 —— 用 SAVEPOINT 隔离。
"""

import json
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

from .schemas import SyncOpIn

log = logging.getLogger(__name__)

# 骨架期只认这一种实体；Step 2 起按 DESIGN.md 扩展
_HANDLERS = {"ping_event"}


def _apply_effect(db: Session, op: SyncOpIn) -> None:
    """产生业务副作用。必须与 sync_op 的插入处在同一事务内。"""
    if op.entity == "ping_event":
        label = op.payload.get("label")
        if not isinstance(label, str) or not label:
            raise ValueError("ping_event.label 必须是非空字符串")
        db.execute(
            text(
                """
                INSERT INTO ping_event (op_id, label, created_at)
                VALUES (:op_id, :label, :created_at)
                """
            ),
            {"op_id": str(op.op_id), "label": label, "created_at": op.client_ts},
        )
    else:
        raise ValueError(f"未知实体: {op.entity}")


def apply_ops(db: Session, client_id: str, ops: list[SyncOpIn]):
    """逐条幂等地应用操作。返回 (applied, duplicate, rejected)。"""
    applied: list = []
    duplicate: list = []
    rejected: list = []

    for op in ops:
        if op.entity not in _HANDLERS:
            rejected.append({"op_id": op.op_id, "reason": f"未知实体: {op.entity}"})
            continue

        try:
            # SAVEPOINT：这一条炸了只回滚它自己，前面成功的不受影响
            with db.begin_nested():
                # 幂等的关键：主键冲突时什么都不做，并且**不返回行**。
                # 拿到行 = 我们是第一个写入者 = 应该产生副作用。
                # 拿不到行 = 别人（或上一次重放）已经写过 = 跳过。
                row = db.execute(
                    text(
                        """
                        INSERT INTO sync_op
                            (op_id, client_id, entity, op_type, payload, client_seq, client_ts)
                        VALUES
                            (:op_id, :client_id, :entity, :op_type,
                             CAST(:payload AS jsonb), :client_seq, :client_ts)
                        ON CONFLICT (op_id) DO NOTHING
                        RETURNING op_id
                        """
                    ),
                    {
                        "op_id": str(op.op_id),
                        "client_id": client_id,
                        "entity": op.entity,
                        "op_type": op.op_type,
                        "payload": json.dumps(op.payload),
                        "client_seq": op.client_seq,
                        "client_ts": op.client_ts,
                    },
                ).first()

                if row is None:
                    duplicate.append(op.op_id)
                    continue

                _apply_effect(db, op)

                db.execute(
                    text("UPDATE sync_op SET applied_at = now() WHERE op_id = :op_id"),
                    {"op_id": str(op.op_id)},
                )
                applied.append(op.op_id)

        except Exception as exc:  # noqa: BLE001 — 单条失败不应中断整批
            log.warning("op %s 被拒绝: %s", op.op_id, exc)
            rejected.append({"op_id": op.op_id, "reason": f"{type(exc).__name__}: {exc}"})

    db.commit()
    return applied, duplicate, rejected


def fetch_changes(db: Session, since_cursor: int, client_id: str, limit: int = 500):
    """拉取 since_cursor 之后、由**其它设备**产生的已生效变更。

    过滤掉自己产生的，避免客户端把刚写的东西再应用一遍。
    """
    rows = db.execute(
        text(
            """
            SELECT seq, op_id, client_id, entity, client_ts, payload
              FROM sync_op
             WHERE seq > :since
               AND applied_at IS NOT NULL
               AND client_id <> :client_id
             ORDER BY seq
             LIMIT :limit
            """
        ),
        {"since": since_cursor, "client_id": client_id, "limit": limit},
    ).mappings().all()

    # 游标只推进到本次真正返回的最后一条 ——
    # 若直接用 MAX(seq)，在被 LIMIT 截断时会漏掉中间的变更。
    next_cursor = rows[-1]["seq"] if rows else since_cursor

    # 但如果没被截断，说明到 max(seq) 为止已经全部消费完
    #（中间被过滤掉的都是自己产生的），可以安全跳过去。
    # 否则自己写的每一条都会在后续每次同步里被重复扫描。
    if len(rows) < limit:
        max_applied = db.execute(
            text("SELECT COALESCE(MAX(seq), 0) FROM sync_op WHERE applied_at IS NOT NULL")
        ).scalar_one()
        next_cursor = max(next_cursor, max_applied)

    return [dict(r) for r in rows], next_cursor
