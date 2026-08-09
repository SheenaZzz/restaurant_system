"""登录 / 续期 / 登出 / 当前用户。"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AppUser, AuthSession, Device
from ..core.deps import CurrentUser, user_by_username
from ..core.security import (
    create_access_token,
    hash_refresh_token,
    new_refresh_token,
    refresh_ttl_for,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    # 设备标识，用于审计和"iPad 丢了吊销这台设备"
    client_id: str = Field(min_length=1, max_length=64)


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    username: str
    display_name: str
    role: str


class RefreshIn(BaseModel):
    refresh_token: str


class MeOut(BaseModel):
    id: int
    username: str
    display_name: str
    role: str


def _touch_device(db: Session, client_id: str) -> Device:
    dev = db.scalar(select(Device).where(Device.client_id == client_id))
    now = datetime.now(timezone.utc)
    if dev is None:
        dev = Device(client_id=client_id, first_seen=now, last_seen=now)
        db.add(dev)
        db.flush()
    else:
        dev.last_seen = now
    return dev


def _issue(db: Session, user, device: Device | None) -> TokenOut:
    raw, hashed = new_refresh_token()
    now = datetime.now(timezone.utc)
    ttl = refresh_ttl_for(user.role)
    db.add(
        AuthSession(
            user_id=user.id,
            device_id=device.id if device else None,
            refresh_token_hash=hashed,
            issued_at=now,
            expires_at=now + ttl,
        )
    )
    db.commit()
    return TokenOut(
        access_token=create_access_token(user.id, user.username, user.role),
        refresh_token=raw,
        expires_in=15 * 60,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
    )


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    user = user_by_username(db, body.username)

    # 用户不存在和密码错误返回**同一个**错误，且都要走一次密码校验，
    # 否则响应时间差会泄露"这个用户名存在"
    ok = bool(user and user.active and verify_password(body.password, user.password_hash))
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="用户名或密码错误"
        )

    device = _touch_device(db, body.client_id)
    return _issue(db, user, device)


@router.post("/refresh", response_model=TokenOut)
def refresh(body: RefreshIn, db: Session = Depends(get_db)):
    hashed = hash_refresh_token(body.refresh_token)
    sess = db.scalar(
        select(AuthSession).where(AuthSession.refresh_token_hash == hashed)
    )
    now = datetime.now(timezone.utc)
    if sess is None or sess.revoked_at is not None or sess.expires_at <= now:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="会话已失效，请重新登录"
        )

    user = db.get(AppUser, sess.user_id)
    if user is None or not user.active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="账号已停用")

    # 轮换：旧的立刻作废，换一张新的。
    # 这样 refresh token 一旦泄露，正常使用会让攻击者的那张失效（反之亦然），
    # 至少能被发现。
    sess.revoked_at = now
    device = db.get(Device, sess.device_id) if sess.device_id else None
    return _issue(db, user, device)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(body: RefreshIn, db: Session = Depends(get_db)):
    hashed = hash_refresh_token(body.refresh_token)
    sess = db.scalar(
        select(AuthSession).where(AuthSession.refresh_token_hash == hashed)
    )
    if sess and sess.revoked_at is None:
        sess.revoked_at = datetime.now(timezone.utc)
        db.commit()
    # 无论找没找到都返回 204 —— 不泄露 token 是否有效


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser):
    return MeOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
    )
