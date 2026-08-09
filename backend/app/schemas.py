from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field


class SyncOpIn(BaseModel):
    """客户端 outbox 里的一条待同步操作。"""

    # 客户端生成，全局唯一。重放安全的唯一依据。
    op_id: UUID
    entity: str = Field(min_length=1, max_length=64)
    op_type: Literal["insert"]
    # 同一设备内单调递增，保证设备内顺序
    client_seq: int = Field(ge=0)
    # 离线期间的真实发生时刻
    client_ts: datetime
    payload: dict[str, Any]


class SyncRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    # 客户端已消费到的服务端序号
    since_cursor: int = Field(default=0, ge=0)
    # 上限防止一次请求过大；客户端超出就分批
    ops: list[SyncOpIn] = Field(default_factory=list, max_length=500)


class RejectedOp(BaseModel):
    op_id: UUID
    reason: str


class ChangeOut(BaseModel):
    seq: int
    op_id: UUID
    client_id: str
    entity: str
    # 操作在源设备上**实际发生**的时刻。
    # payload 里没有时间，必须由这里带出去 —— 否则接收端只能用
    # "收到的时刻"，离线积压两小时的记录会全被打上"刚刚"的时间戳。
    client_ts: datetime
    # 操作人显示名 —— 清单页要显示"谁操作的"。
    # 客户端本地只知道自己那些 op 是谁做的，别人的必须由服务端带出来。
    user_display: str | None = None
    payload: dict[str, Any]


class SyncResponse(BaseModel):
    # 本次真正产生了副作用的
    applied: list[UUID]
    # 服务端已见过、这次跳过的（重放的正常结果，不是错误）
    duplicate: list[UUID]
    # 校验或业务失败的，客户端应保留并告警
    rejected: list[RejectedOp]
    # 客户端下次带回来的游标
    cursor: int
    # 其它设备产生的变更
    changes: list[ChangeOut]
