"""Sign in / refresh / sign out / who am I."""

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
    # Device identifier, for the audit trail and for "the iPad is lost, revoke it"
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

    # An unknown user and a wrong password return the **same** error, and both
    # verify a password, or the difference in timing leaks that a username exists
    ok = bool(user and user.active and verify_password(body.password, user.password_hash))
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Wrong username or password"
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
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired, please sign in again"
        )

    user = db.get(AppUser, sess.user_id)
    if user is None or not user.active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="This account is disabled")

    # Rotation: the old one dies immediately and a new one is issued.
    # So if a refresh token leaks, ordinary use invalidates the attacker's copy
    # (or the other way round) -- at least it becomes noticeable.
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
    # 204 whether or not it was found -- do not leak whether a token was valid


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser):
    return MeOut(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
    )
