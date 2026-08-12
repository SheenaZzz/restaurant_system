"""The sync core: idempotent intake and incremental push.

The correctness of the whole offline-first design rests on this file, so the logic is deliberately plain.

Invariants
------
1. However often an op_id is replayed, its side effect happens once.
2. "Record the sync_op" and "produce the side effect" both happen or
   neither does -- they have to share a transaction. A crash in between
   would leave a "recorded but never applied" hole that replay then skips
   as a duplicate, and the row is gone for good.
3. One failing op must not take the batch down -- SAVEPOINT isolates it.
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
    add_payment,
    set_payment,
    transfer_check,
    void_check,
    void_order_line,
)
from .services.buffet import record_tray_event

log = logging.getLogger(__name__)

# The roles each entity needs. Authorisation on the write path reads **only**
# this table, never anything the client claims about itself.
_FRONT = frozenset({"front_employee", "front_manager", "admin"})
# Editing and voiding **make money disappear** -- managers and the owner only
_FRONT_MANAGER = frozenset({"front_manager", "admin"})

_HANDLERS: dict[str, frozenset[str]] = {
    "open_check": _FRONT,
    "close_check": _FRONT,
    # Transferring, merging and changing the payment method move no money, so
    # regular staff can do them -- needing a manager every time is enough
    # friction that people stop recording anything
    "transfer_check": _FRONT,
    "merge_checks": _FRONT,
    "set_payment": _FRONT,
    # Top-ups are open to regular staff too: money in hand has to be recorded
    # now, and waiting for a manager at peak means it never gets recorded
    "add_payment": _FRONT,
    # To-go and adding dishes are daily work
    "open_togo_check": _FRONT,
    "add_order_lines": _FRONT,
    "void_order_line": _FRONT,
    "modify_check": _FRONT_MANAGER,
    "void_check": _FRONT_MANAGER,
    "restore_check": _FRONT_MANAGER,
    # Refills: **the front and the kitchen can both record them**. A cook
    # tapping while refilling is the natural case, but the person who notices
    # an empty tray is usually a server -- kitchen-only would lose most of the
    # "ran empty" events, and those are the right-hand end of the censoring interval.
    "tray_event": _FRONT | {"kitchen"},
}


def _apply_effect(db: Session, op: SyncOpIn, user) -> None:
    """Produce the business side effect. Has to share the transaction with the sync_op insert."""
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

    elif op.entity == "add_payment":
        add_payment(db, op.payload, op.client_ts)

    elif op.entity == "open_togo_check":
        open_togo_check(db, op.op_id, op.payload, op.client_ts,
                        user.id if user else None)

    elif op.entity == "add_order_lines":
        add_order_lines(db, op.payload, op.client_ts)

    elif op.entity == "void_order_line":
        void_order_line(db, op.payload, op.client_ts)

    elif op.entity == "tray_event":
        record_tray_event(db, op.payload, op.client_ts, user.id if user else None)

    else:
        raise ValueError(f"Unknown entity: {op.entity}")


def apply_ops(db: Session, client_id: str, ops: list[SyncOpIn], user=None):
    """Apply ops one by one, idempotently. Returns (applied, duplicate, rejected).

    `user` comes from the access token the server verified, **not from anything
    the client says about itself**. Every op records its user_id -- walkouts,
    comps and voids have to be traceable to a person or there is no control at all.
    """
    applied: list = []
    duplicate: list = []
    rejected: list = []

    for op in ops:
        allowed = _HANDLERS.get(op.entity)
        if allowed is None:
            rejected.append({"op_id": op.op_id, "reason": f"Unknown entity: {op.entity}"})
            continue

        # ⚠️ Authorisation happens here, not in the front end.
        # Ops queued on a client while offline carry no role claim --
        # the role comes only from the access token the server verified.
        if user is not None and user.role not in allowed:
            rejected.append(
                {
                    "op_id": op.op_id,
                    "reason": f"{user.role} may not perform {op.entity}",
                }
            )
            continue

        try:
            # SAVEPOINT: if this one blows up it rolls back alone, and the ops before it stand
            with db.begin_nested():
                # The heart of idempotency: on a key conflict do nothing and
                # **return no row**. Got a row = we are the first writer = the
                # side effect is ours. No row = someone (or an earlier replay) already did it.
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

        except Exception as exc:  # noqa: BLE001 -- one failure must not stop the batch
            log.warning("op %s rejected: %s", op.op_id, exc)
            rejected.append({"op_id": op.op_id, "reason": f"{type(exc).__name__}: {exc}"})

    db.commit()
    return applied, duplicate, rejected


def log_truncated(db: Session, since_cursor: int) -> bool:
    """The client consumed up to since_cursor, but **not one record at or below**
    **that seq is left in the log**.

    In normal operation that cannot happen: a cursor of N means 1..N existed,
    and one of them is still there. Only a log that was deleted wholesale (test
    data cleared, retention archiving) produces it.

    An increment is then not enough -- the client's mirror holds checks the
    server no longer has, and since sync is **append-only** nothing later will
    ever remove them. The device would show them forever. So it starts over.

    ⚠️ The test cannot be `since_cursor > MAX(seq)`: seq is a bigserial and
       DELETE does not wind it back. After a purge, one write from another
       device is seq 80, so the device sitting at 79 looks fine and never agrees again.
    """
    if since_cursor <= 0:
        return False
    hit = db.execute(
        text("SELECT 1 FROM sync_op WHERE seq <= :n LIMIT 1"), {"n": since_cursor}
    ).first()
    return hit is None


def fetch_changes(
    db: Session,
    since_cursor: int,
    client_id: str,
    limit: int = 500,
    resync: bool = False,
):
    """Fetch applied changes after since_cursor that came from **other devices**.

    Filtering out its own keeps a client from applying what it just wrote.

    With `resync=True` **nothing is filtered**: the client just emptied its
    mirror, so its own checks have to be sent again or a chunk is simply missing.
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
               AND (:resync OR s.client_id <> :client_id)
             ORDER BY s.seq
             LIMIT :limit
            """
        ),
        {
            "since": since_cursor,
            "client_id": client_id,
            "limit": limit,
            "resync": resync,
        },
    ).mappings().all()

    # The cursor only advances to the last row actually returned -- using
    # MAX(seq) would skip changes in the middle whenever LIMIT truncated.
    next_cursor = rows[-1]["seq"] if rows else since_cursor

    # But an untruncated page means everything up to max(seq) is consumed
    # (whatever was filtered out came from this device), so it is safe to jump.
    # Otherwise every op this device wrote gets rescanned on every later sync.
    if len(rows) < limit:
        max_applied = db.execute(
            text("SELECT COALESCE(MAX(seq), 0) FROM sync_op WHERE applied_at IS NOT NULL")
        ).scalar_one()
        next_cursor = max(next_cursor, max_applied)

    return [dict(r) for r in rows], next_cursor
