"""自助餐台：布局（buffet_dish）与补菜事件（tray_event）。

补菜事件是这个项目里唯一**不可直接观测**的量的入口：
消耗速度没人能读出来，只有「t₁ 补满、t₂ 发现空了」这样的区间截尾事件。
所以这条路径的每一个字段都要为"事后能建模"服务，而不是为"界面好写"服务。
"""

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import BuffetDish, TrayEvent

PERIODS = ("lunch", "dinner")
PAGES = 3
SLOTS = 10

# 台前只有 补 / 半 / 空 三个按钮。
# discard（倒掉）是浪费估算的唯一来源，但会加操作负担 —— 等这三个跑顺了再上。
EVENT_TYPES = ("refill", "half", "empty", "discard")

# 允许往前回拨多久。超过三小时的"补记"已经不是补记了，那是猜的，
# 喂进模型只会污染区间端点。
MAX_BACKDATE_MIN = 180


class BuffetError(Exception):
    """业务校验失败。会被 sync 转成这一条 op 的 rejected 原因。"""


def load_board(db: Session) -> dict[str, list[dict]]:
    """整块板，按时段分组。给 /api/catalog 下发 —— 补菜页必须离线可用。"""
    rows = db.scalars(
        select(BuffetDish)
        .where(BuffetDish.active.is_(True))
        .order_by(BuffetDish.period_kind, BuffetDish.page, BuffetDish.pos)
    ).all()
    out: dict[str, list[dict]] = {p: [] for p in PERIODS}
    for r in rows:
        out.setdefault(r.period_kind, []).append(
            {
                "id": r.id,
                "page": r.page,
                "pos": r.pos,
                "name_zh": r.name_zh,
                "name_en": r.name_en,
            }
        )
    return out


def record_tray_event(
    db: Session, payload: dict, client_ts: datetime, user_id: int | None
) -> None:
    """记一次补菜/见底。**append-only，没有更新也没有删除。**

    误点了怎么办：紧接着记一条正确的。两条相隔几秒的事件在建模时
    是可分辨的，而"能修改的事实表"会让整张表失去可信度 ——
    到时候谁也说不清某条记录是当时记的还是后来改的。

    时间不取服务端的 now()：
      observed_at = 设备上这条 op 的时刻 − 回拨的分钟数
    离线两小时后补发的记录必须落在**当时**，不是收到的时刻。
    """
    dish_id = payload.get("dish_id")
    if not isinstance(dish_id, int):
        raise BuffetError(f"dish_id 非法: {dish_id!r}")

    kind = payload.get("event_type")
    if kind not in EVENT_TYPES:
        raise BuffetError(f"事件类型非法: {kind!r}")

    back = payload.get("minutes_ago", 0)
    if not isinstance(back, int) or not 0 <= back <= MAX_BACKDATE_MIN:
        raise BuffetError(f"回拨分钟数非法: {back!r}")

    dish = db.get(BuffetDish, dish_id)
    if dish is None:
        raise BuffetError(f"这道菜不在台面上: {dish_id}")

    db.add(
        TrayEvent(
            buffet_dish_id=dish_id,
            event_type=kind,
            observed_at=client_ts - timedelta(minutes=back),
            recorded_by=user_id,
        )
    )


def set_board(db: Session, period_kind: str, rows: list[dict]) -> None:
    """整块板按顺序整份替换（老板改价页里那一份）。

    和加料目录同一个规矩：带 id 的原地改，没 id 的新增，
    **没出现在列表里的停用**（不是删除 —— tray_event 指着它，
    删了历史补菜记录就断链了）。

    ⚠️ 原地改 = 改名，历史接得上；换成另一道菜要删掉再加，
       否则新菜会继承旧菜的消耗历史。这条规矩界面上写着。
    """
    if period_kind not in PERIODS:
        raise BuffetError(f"时段非法: {period_kind}")

    kept: list[BuffetDish] = []
    for r in rows:
        page, pos = r["page"], r["pos"]
        if not (1 <= page <= PAGES and 1 <= pos <= SLOTS):
            raise BuffetError(f"位置越界: 第 {page} 页第 {pos} 格")
        name = (r.get("name_zh") or "").strip()
        if not name:
            raise BuffetError("菜名不能为空")

        rid = r.get("id")
        if rid is None:
            row = BuffetDish(period_kind=period_kind, page=page, pos=pos, name_zh=name)
            db.add(row)
        else:
            row = db.get(BuffetDish, rid)
            if row is None or row.period_kind != period_kind:
                raise BuffetError(f"这道菜不在这块板上: {rid}")
            row.page = page
            row.pos = pos
            row.name_zh = name
        row.name_en = (r.get("name_en") or "").strip()
        row.active = True
        kept.append(row)

    # ⚠️ 按对象跟踪，不能按 id：新增的行 flush 之前 id 是 None，
    #    用 id 集合的话它们会被下面的停用循环当成"不在列表里"立刻停掉。
    db.flush()
    keep_ids = {r.id for r in kept}
    for row in db.scalars(
        select(BuffetDish).where(
            BuffetDish.period_kind == period_kind, BuffetDish.active.is_(True)
        )
    ):
        if row.id not in keep_ids:
            row.active = False
