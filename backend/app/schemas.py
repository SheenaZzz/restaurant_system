from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


class SyncOpIn(BaseModel):
    """One pending operation from a client's outbox."""

    # Client-generated and globally unique. The only thing that makes replay safe.
    op_id: UUID
    entity: str = Field(min_length=1, max_length=64)
    op_type: Literal["insert"]
    # Monotonic within a device, which preserves that device's ordering
    client_seq: int = Field(ge=0)
    # When it really happened, offline
    client_ts: datetime
    payload: dict[str, Any]


class SyncRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    # The server sequence number the client has consumed up to
    since_cursor: int = Field(default=0, ge=0)
    # A ceiling so one request cannot be enormous; the client batches past it
    ops: list[SyncOpIn] = Field(default_factory=list, max_length=500)
    # The client just emptied its mirror and wants everything again (including
    # its own writes). Only true after the server answered reset=True.
    resync: bool = False


class RejectedOp(BaseModel):
    op_id: UUID
    reason: str


class ChangeOut(BaseModel):
    seq: int
    op_id: UUID
    client_id: str
    entity: str
    # When the operation **actually happened** on the source device.
    # The payload has no time in it, so it has to be carried here -- otherwise
    # the receiver only has "when it arrived", and two hours of queued offline
    # work all gets stamped "just now".
    client_ts: datetime
    # Display name of whoever did it -- the check list shows "who did this".
    # A client only knows that for its own ops; everyone else's has to come from the server.
    user_display: str | None = None
    payload: dict[str, Any]


class SyncResponse(BaseModel):
    # Ops that actually produced a side effect this time
    applied: list[UUID]
    # Ops the server had already seen and skipped (a normal replay result, not an error)
    duplicate: list[UUID]
    # Rejected by validation or a business rule; the client keeps them and warns
    rejected: list[RejectedOp]
    # The cursor the client sends back next time
    cursor: int
    # Changes produced by other devices
    changes: list[ChangeOut]
    # The server's log no longer holds anything before this cursor -- the
    # client should empty its mirror, reset the cursor and come back with resync. See sync.log_truncated.
    reset: bool = False
