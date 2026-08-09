"""价格解析。

**价格永远在服务端解析，绝不信客户端传来的金额。**

两个理由：
  1. 客户端可能拿着几天前缓存的旧价（离线时更是必然）
  2. 前端传什么金额就记什么金额 = 谁都能给自己打折

客户端缓存价格只用于**界面上先显示个数字**，落库的以服务端为准。
"""

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import BuffetPrice


def resolve_head_prices(
    db: Session, period_kind: str, on: date
) -> dict[tuple[str, str | None], int]:
    """返回 {(charge_kind, guest_type): price_cents}。

    取 effective_from <= on 里最新的一条 —— 改价是**新增一行**而不是
    覆盖旧行，所以历史账单永远按当时的价格算。
    """
    rows = db.scalars(
        select(BuffetPrice)
        .where(
            BuffetPrice.period_kind == period_kind,
            BuffetPrice.effective_from <= on,
        )
        .order_by(BuffetPrice.effective_from)
    ).all()

    out: dict[tuple[str, str | None], int] = {}
    for r in rows:  # 按 effective_from 升序，后面的覆盖前面的
        out[(r.charge_kind, r.guest_type)] = r.price_cents
    return out
