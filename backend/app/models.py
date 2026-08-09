"""SQLAlchemy 模型 —— schema 的单一事实来源。

对应 DESIGN.md 第 4 节。Alembic 迁移由这里 autogenerate。

命名上的两处偏离 DESIGN.md（都是为了避开 SQL 关键字/歧义）：
  check   → dining_check   （`check` 是 SQL 保留字，到处加引号很难受）
  session → auth_session   （`session` 和 SQLAlchemy 的 Session 撞名）
"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID as PgUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


# 全库统一用 timestamptz。绝不用 naive datetime ——
# 餐馆跨午市/晚市、还有夏令时，时区歧义会直接毁掉营业统计。
TZDateTime = DateTime(timezone=True)


# ---------------------------------------------------------------------------
# 菜单与价格
# ---------------------------------------------------------------------------


class MenuItem(Base):
    __tablename__ = "menu_item"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name_en: Mapped[str] = mapped_column(Text, nullable=False)
    name_zh: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(Text, nullable=False)
    # buffet 台上的菜没有单价
    price_cents: Mapped[int | None] = mapped_column(Integer)
    is_buffet_dish: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # 'wok' / 'fryer' / 'cold' / 'drink' / 'none'
    # 'none' 和 'drink' 不进后厨队列 —— 这是"要不要出票"的唯一判据
    station: Mapped[str] = mapped_column(Text, nullable=False, default="none")
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (
        CheckConstraint(
            "station IN ('wok','fryer','cold','drink','none')", name="ck_menu_station"
        ),
        CheckConstraint(
            "price_cents IS NULL OR price_cents >= 0", name="ck_menu_price_nonneg"
        ),
        Index("ix_menu_item_active", "active", "category"),
    )


class ServicePeriod(Base):
    """一个营业时段（某天的午市或晚市）。所有单据都挂在它下面。"""

    __tablename__ = "service_period"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    opened_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (
        CheckConstraint("kind IN ('lunch','dinner')", name="ck_period_kind"),
        UniqueConstraint("business_date", "kind", name="uq_period_date_kind"),
    )


class BuffetPrice(Base):
    """人头价。改价用新增一行 + effective_from，**不覆盖历史** ——
    否则改一次价，之前所有账单的金额就跟着变了。"""

    __tablename__ = "buffet_price"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    period_kind: Mapped[str] = mapped_column(Text, nullable=False)
    # 'admission' 按 guest_type 分档；'drink' 不分
    charge_kind: Mapped[str] = mapped_column(Text, nullable=False)
    guest_type: Mapped[str | None] = mapped_column(Text)
    price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)

    __table_args__ = (
        CheckConstraint("period_kind IN ('lunch','dinner')", name="ck_bp_period"),
        CheckConstraint("charge_kind IN ('admission','drink')", name="ck_bp_kind"),
        CheckConstraint(
            "guest_type IS NULL OR guest_type IN ('adult','child','senior')",
            name="ck_bp_guest_type",
        ),
        CheckConstraint(
            "charge_kind <> 'admission' OR guest_type IS NOT NULL",
            name="ck_bp_admission_needs_guest_type",
        ),
        CheckConstraint("price_cents >= 0", name="ck_bp_price_nonneg"),
    )


# ---------------------------------------------------------------------------
# 桌与账单
# ---------------------------------------------------------------------------


class DiningTable(Base):
    __tablename__ = "dining_table"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    seats: Mapped[int] = mapped_column(Integer, nullable=False)
    zone: Mapped[str | None] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class DiningCheck(Base):
    """一张账单。DESIGN.md 里叫 `check`（SQL 保留字，这里改名）。

    **核心建模点**：同一张账单下同时挂 head_charge（人头）和
    order_line（单品）—— 一家人吃 buffet 另点一份海鲜就是这个形态。
    """

    __tablename__ = "dining_check"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # 客户端生成的身份（就是创建它那条 op 的 op_id）。
    #
    # 为什么需要它：开桌必须离线可用，但主键 id 是数据库生成的，
    # 客户端离线时拿不到。于是后续操作（加菜、结账）没法引用这张单。
    # 解法是让客户端自己生成一个 UUID 作为对外标识，
    # 服务端的 bigint 主键只在服务端内部用。
    client_uuid: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), unique=True
    )
    # pickup 单没有桌号
    table_id: Mapped[int | None] = mapped_column(ForeignKey("dining_table.id"))
    period_id: Mapped[int] = mapped_column(
        ForeignKey("service_period.id"), nullable=False
    )
    source: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    opened_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    opened_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))

    __table_args__ = (
        CheckConstraint("source IN ('dine_in','pickup')", name="ck_check_source"),
        CheckConstraint(
            "status IN ('open','closed','voided')", name="ck_check_status"
        ),
        # 堂食必须有桌号，自取必须没有
        CheckConstraint(
            "(source = 'dine_in' AND table_id IS NOT NULL)"
            " OR (source = 'pickup' AND table_id IS NULL)",
            name="ck_check_table_matches_source",
        ),
        Index("ix_check_period_status", "period_id", "status"),
        # **一张桌同时只能有一张未结账单**。
        # 两个服务员离线时都以为 A7 是空的、各开一单 —— 恢复后
        # 第二条会撞这个约束被拒，进死信队列，UI 上以红色"失败"暴露，
        # 由人来决定合并还是重开。这类冲突不该被静默吞掉。
        Index(
            "uq_check_open_per_table",
            "table_id",
            unique=True,
            postgresql_where="status = 'open' AND table_id IS NOT NULL",
        ),
    )


class HeadCharge(Base):
    """人头计费：buffet 入场费 + 饮料（按人无限续杯）。

    饮料按人收费，所以它**不是** order_line —— 它和入场费一样是
    "按人头一次性收"，只是 kind 不同。
    """

    __tablename__ = "head_charge"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    check_id: Mapped[int] = mapped_column(
        ForeignKey("dining_check.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    guest_type: Mapped[str | None] = mapped_column(Text)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price_cents: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        CheckConstraint("kind IN ('admission','drink')", name="ck_head_kind"),
        CheckConstraint(
            "guest_type IS NULL OR guest_type IN ('adult','child','senior')",
            name="ck_head_guest_type",
        ),
        # 入场费必须分成人/儿童/长者；饮料不分
        CheckConstraint(
            "kind <> 'admission' OR guest_type IS NOT NULL",
            name="ck_head_admission_needs_guest_type",
        ),
        CheckConstraint("qty > 0", name="ck_head_qty_pos"),
        CheckConstraint("unit_price_cents >= 0", name="ck_head_price_nonneg"),
        Index("ix_head_charge_check", "check_id"),
    )


class OrderLine(Base):
    """单品计费：堂食单点 + pickup。饮料不走这里。"""

    __tablename__ = "order_line"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    check_id: Mapped[int] = mapped_column(
        ForeignKey("dining_check.id", ondelete="CASCADE"), nullable=False
    )
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_item.id"), nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False)
    # 下单当时的价格快照 —— 不能 join menu_item 取现价，
    # 否则改一次菜单，历史账单金额全变
    unit_price_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="placed")
    placed_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    fired_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    ready_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (
        CheckConstraint(
            "status IN ('placed','fired','ready','served','voided')",
            name="ck_line_status",
        ),
        CheckConstraint("qty > 0", name="ck_line_qty_pos"),
        CheckConstraint("unit_price_cents >= 0", name="ck_line_price_nonneg"),
        Index("ix_order_line_check", "check_id"),
        # 后厨队列的查询路径
        Index("ix_order_line_open", "status", "placed_at"),
    )


class PickupOrder(Base):
    """电话自取单。

    PII 原则：**只存手机号后四位**，够核对身份就行。
    """

    __tablename__ = "pickup_order"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    check_id: Mapped[int] = mapped_column(
        ForeignKey("dining_check.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    customer_name: Mapped[str | None] = mapped_column(Text)
    phone_last4: Mapped[str | None] = mapped_column(String(4))
    # 客人说的到店时间
    promised_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    # 实际到店 / 实际取走 —— 两者之差就是"人等餐"，
    # promised 与 arrived 之差是估计偏差，都是后面做出餐时机调度的输入
    arrived_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    picked_up_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="placed")

    __table_args__ = (
        CheckConstraint(
            "status IN ('placed','ready','picked_up','no_show','voided')",
            name="ck_pickup_status",
        ),
        CheckConstraint(
            "phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$'",
            name="ck_pickup_phone_last4",
        ),
    )


# ---------------------------------------------------------------------------
# Buffet 补菜事件 —— 后续所有预测的唯一数据源
# ---------------------------------------------------------------------------


class TrayEvent(Base):
    """补菜/见底事件。append-only。

    这张表是整个项目的技术内核：buffet 消耗量**不可直接观测**，
    只有 t1 补满、t2 发现空了 这样的**区间截尾事件**，
    而且"发现空了"本身还是延迟的。要从这些稀疏事件反推消耗速率。
    """

    __tablename__ = "tray_event"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    menu_item_id: Mapped[int] = mapped_column(ForeignKey("menu_item.id"), nullable=False)
    event_type: Mapped[str] = mapped_column(Text, nullable=False)
    # 0.0–1.0，refill / discard 时记录
    fill_level: Mapped[float | None] = mapped_column(Numeric(3, 2))
    observed_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    recorded_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))

    __table_args__ = (
        CheckConstraint(
            "event_type IN ('refill','half','empty','discard')", name="ck_tray_type"
        ),
        CheckConstraint(
            "fill_level IS NULL OR (fill_level >= 0 AND fill_level <= 1)",
            name="ck_tray_fill_range",
        ),
        Index("ix_tray_item_time", "menu_item_id", "observed_at"),
    )


# ---------------------------------------------------------------------------
# 异常与日结
# ---------------------------------------------------------------------------


class CheckException(Base):
    """逃单 / 免单 / 退菜。**这是钱漏掉的地方，也是唯一需要内控的路径。**"""

    __tablename__ = "check_exception"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    check_id: Mapped[int] = mapped_column(ForeignKey("dining_check.id"), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    # 必填，不许空 —— 没有原因的免单就是没有内控
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    recorded_by: Mapped[int] = mapped_column(ForeignKey("app_user.id"), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    # 超过阈值需 admin 事后追认
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    approved_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (
        CheckConstraint(
            "kind IN ('walkout','comp','discount','void','remake','other')",
            name="ck_exc_kind",
        ),
        CheckConstraint("length(btrim(reason)) > 0", name="ck_exc_reason_nonempty"),
        Index("ix_exception_time", "recorded_at"),
    )


class DailyBatch(Base):
    """日结。核心不是"算营业额"，是**对账**：
    系统算出的应收 vs 卡机/钱箱里实际的钱，差多少。

    系统不碰支付，所以 reported_* 全靠手工录入 ——
    正是这个"计算值 vs 上报值"的差额，才是日结真正的价值。
    """

    __tablename__ = "daily_batch"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    business_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)

    # 系统算出来的
    computed_admission_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    computed_drink_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    computed_item_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    computed_total_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    guest_adult: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    guest_child: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    guest_senior: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    check_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    exception_total_cents: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # 手工录入（来自信用卡机和钱箱）
    reported_card_cents: Mapped[int | None] = mapped_column(Integer)
    reported_card_tips_cents: Mapped[int | None] = mapped_column(Integer)
    reported_cash_cents: Mapped[int | None] = mapped_column(Integer)
    reported_cash_tips_cents: Mapped[int | None] = mapped_column(Integer)

    variance_cents: Mapped[int | None] = mapped_column(Integer)
    # 录入与确认分离 —— 最基本的内控
    closed_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    closed_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    approved_by: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    approved_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    note: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------------------
# 账号、设备、会话
# ---------------------------------------------------------------------------


class AppUser(Base):
    __tablename__ = "app_user"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    username: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    # 4 位 PIN 的哈希，用于同一设备上快速切换账号（归属到人，不是安全边界）
    pin_hash: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("role IN ('front','kitchen','admin')", name="ck_user_role"),
    )


class Device(Base):
    """设备只用于同步游标与审计，**不是授权主体** —— 身份属于账号。"""

    __tablename__ = "device"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    client_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    label: Mapped[str | None] = mapped_column(Text)
    first_seen: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, server_default=func.now()
    )
    last_seen: Mapped[datetime | None] = mapped_column(TZDateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(TZDateTime)


class AuthSession(Base):
    __tablename__ = "auth_session"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("app_user.id"), nullable=False)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("device.id"))
    refresh_token_hash: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    issued_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (Index("ix_session_user_active", "user_id", "expires_at"),)


# ---------------------------------------------------------------------------
# 同步
# ---------------------------------------------------------------------------


class SyncOp(Base):
    """同步日志。既是幂等键的载体，也是全量审计轨迹。"""

    __tablename__ = "sync_op"

    op_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    # ⚠️ 必须显式 Identity()。SQLAlchemy 的 autoincrement=True 只对**主键**
    #    生效，非主键列不会生成序列 —— 建出来就是裸的 NOT NULL 无默认值，
    #    插入时直接 NotNullViolation。原来手写 DDL 用的是 BIGSERIAL。
    seq: Mapped[int] = mapped_column(
        BigInteger, Identity(), nullable=False, unique=True
    )
    client_id: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("app_user.id"))
    entity: Mapped[str] = mapped_column(Text, nullable=False)
    op_type: Mapped[str] = mapped_column(Text, nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    client_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)
    # 客户端时间：离线期间的真实发生时刻（不可信，仅作参考）
    client_ts: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    # 服务端时间：权威时序，冲突解决以它为准
    received_at: Mapped[datetime] = mapped_column(
        TZDateTime, nullable=False, server_default=func.now()
    )
    applied_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    __table_args__ = (
        Index(
            "ix_sync_op_applied_seq",
            "seq",
            postgresql_where="applied_at IS NOT NULL",
        ),
    )


class PingEvent(Base):
    """⚠️ Walking Skeleton 的探针表。Step 4 接入真实业务后删除。"""

    __tablename__ = "ping_event"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # 第二道防线：即使 sync_op 的幂等判断被绕过，
    # 这个 UNIQUE 约束仍让重复写入在数据库层失败
    op_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("sync_op.op_id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
