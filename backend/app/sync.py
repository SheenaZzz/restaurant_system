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
from .services.checks import (
    add_order_lines,
    close_check,
    merge_checks,
    modify_check,
    open_check,
    open_togo_check,
    restore_check,
    set_payment,
    transfer_check,
    void_check,
    void_order_line,
)

log = logging.getLogger(__name__)

# 每个实体需要的角色。写入路径的授权判断**只看这张表**，
# 不看客户端自称的任何东西。
_FRONT = frozenset({"front_employee", "front_manager", "admin"})
# 改单/作废是**能让钱消失**的操作 —— 只有主管和老板可以
_FRONT_MANAGER = frozenset({"front_manager", "admin"})

_HANDLERS: dict[str, frozenset[str]] = {
    "open_check": _FRONT,
    "close_check": _FRONT,
    # 换桌、并桌、改支付方式都不涉及金额增减，给普通员工 ——
    # 每次都要找主管的摩擦太大，反而会导致干脆不记
    "transfer_check": _FRONT,
    "merge_checks": _FRONT,
    "set_payment": _FRONT,
    # 自提与加菜都是日常操作
    "open_togo_check": _FRONT,
    "add_order_lines": _FRONT,
    "void_order_line": _FRONT,
    "modify_check": _FRONT_MANAGER,
    "void_check": _FRONT_MANAGER,
    "restore_check": _FRONT_MANAGER,
    # 骨架探针，Step 5 删除
    "ping_event": _FRONT | {"kitchen"},
}


def _apply_effect(db: Session, op: SyncOpIn, user) -> None:
    """产生业务副作用。必须与 sync_op 的插入处在同一事务内。"""
    if op.entity == "open_check":
        open_check(db, op.op_id, op.payload, op.client_ts, user.id if user else None)

    elif op.entity == "close_check":
        close_check(db, op.payload, op.client_ts)

    elif op.entity == "modify_check":
        modify_check(db, op.payload, op.client_ts)

    elif op.entity == "void_check":
        void_check(db, op.payload, op.client_ts, user.id if user else None)

    elif op.entity == "restore_check":
        restore_check(db, op.payload, op.client_ts, user.id if user else None)

    elif op.entity == "transfer_check":
        transfer_check(db, op.payload, op.client_ts)

    elif op.entity == "merge_checks":
        merge_checks(db, op.payload, op.client_ts)

    elif op.entity == "set_payment":
        set_payment(db, op.payload, op.client_ts)

    elif op.entity == "open_togo_check":
        open_togo_check(db, op.op_id, op.payload, op.client_ts,
                        user.id if user else None)

    elif op.entity == "add_order_lines":
        add_order_lines(db, op.payload, op.client_ts)

    elif op.entity == "void_order_line":
        void_order_line(db, op.payload, op.client_ts)

    elif op.entity == "ping_event":
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


def apply_ops(db: Session, client_id: str, ops: list[SyncOpIn], user=None):
    """逐条幂等地应用操作。返回 (applied, duplicate, rejected)。

    `user` 来自服务端验过的 access token，**不是客户端自称的身份**。
    每条 op 都记下 user_id —— 逃单、免单、作废这些操作必须能追到人，
    否则内控无从谈起。
    """
    applied: list = []
    duplicate: list = []
    rejected: list = []

    for op in ops:
        allowed = _HANDLERS.get(op.entity)
        if allowed is None:
            rejected.append({"op_id": op.op_id, "reason": f"未知实体: {op.entity}"})
            continue

        # ⚠️ 授权在这里，不在前端。
        # 客户端离线期间攒的 op 不带任何角色声明 ——
        # 角色只来自服务端验过的 access token。
        if user is not None and user.role not in allowed:
            rejected.append(
                {
                    "op_id": op.op_id,
                    "reason": f"{user.role} 无权执行 {op.entity}",
                }
            )
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
                            (op_id, client_id, user_id, entity, op_type, payload,
                             client_seq, client_ts)
                        VALUES
                            (:op_id, :client_id, :user_id, :entity, :op_type,
                             CAST(:payload AS jsonb), :client_seq, :client_ts)
                        ON CONFLICT (op_id) DO NOTHING
                        RETURNING op_id
                        """
                    ),
                    {
                        "op_id": str(op.op_id),
                        "client_id": client_id,
                        "user_id": user.id if user else None,
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

                _apply_effect(db, op, user)

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
            SELECT s.seq, s.op_id, s.client_id, s.entity, s.client_ts, s.payload,
                   u.display_name AS user_display
              FROM sync_op s
              LEFT JOIN app_user u ON u.id = s.user_id
             WHERE s.seq > :since
               AND s.applied_at IS NOT NULL
               AND s.client_id <> :client_id
             ORDER BY s.seq
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
