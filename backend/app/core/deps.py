"""Dependency injection for authentication and authorisation.

**This is the only security boundary.** Rendering the front end by role is UX;
every write path has to check again here, or changing one JS variable walks around it.
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
    detail="Not authenticated, or the token has expired",
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
    # Look the account up every time to confirm it is still valid -- a JWT
    # cannot be revoked, but someone leaving has to take effect immediately, which is worth the query
    if user is None or not user.active:
        raise _UNAUTH

    return user


CurrentUser = Annotated[AppUser, Depends(get_current_user)]


def require_role(*allowed: str):
    """Build a dependency that lets only the given roles through.

        @router.get("/admin/x", dependencies=[Depends(require_role("admin"))])
    """

    def _guard(user: CurrentUser) -> AppUser:
        if user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Needs {' or '.join(allowed)}; this account is {user.role}",
            )
        return user

    return _guard


def get_user_optional(
    authorization: Annotated[str | None, Header()] = None,
    db: Session = Depends(get_db),
) -> AppUser | None:
    """For "record it if there is one, allow it either way". Nothing uses it
    yet -- kept in case an anonymous read-only page ever appears."""
    try:
        return get_current_user(authorization, db)
    except HTTPException:
        return None


def user_by_username(db: Session, username: str) -> AppUser | None:
    return db.scalar(select(AppUser).where(AppUser.username == username))
