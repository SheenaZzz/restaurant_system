"""认证与授权的依赖注入。

**这里是唯一的安全边界。** 前端按 role 渲染界面只是 UX ——
任何写入路径都必须在这一层重新验一次，否则改个 JS 变量就绕过去了。
"""

from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AppUser
from .security import decode_access_token

_UNAUTH = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="未认证或令牌已过期",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    db: Session = Depends(get_db),
) -> AppUser:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _UNAUTH

    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = decode_access_token(token)
    except jwt.PyJWTError:
        raise _UNAUTH from None

    user = db.get(AppUser, int(payload["sub"]))
    # 每次都查库确认账号仍然有效 —— JWT 本身无法撤销，
    # 但离职/停用必须立刻生效，这点开销值得付
    if user is None or not user.active:
        raise _UNAUTH

    return user


CurrentUser = Annotated[AppUser, Depends(get_current_user)]


def require_role(*allowed: str):
    """生成一个只放行指定角色的依赖。

        @router.get("/admin/x", dependencies=[Depends(require_role("admin"))])
    """

    def _guard(user: CurrentUser) -> AppUser:
        if user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"需要 {' 或 '.join(allowed)} 权限，当前是 {user.role}",
            )
        return user

    return _guard


def get_user_optional(
    authorization: Annotated[str | None, Header()] = None,
    db: Session = Depends(get_db),
) -> AppUser | None:
    """给"有则记录、无则放行"的场景用。当前没有用到 ——
    保留是因为将来可能有匿名只读页面。"""
    try:
        return get_current_user(authorization, db)
    except HTTPException:
        return None


def user_by_username(db: Session, username: str) -> AppUser | None:
    return db.scalar(select(AppUser).where(AppUser.username == username))
