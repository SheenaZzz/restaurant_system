"""密码哈希与令牌签发。

两类令牌，寿命差一个数量级：

  access token   —— JWT，15 分钟，不落库。每个请求带它。
  refresh token  —— 随机串，只把**哈希**存库。用来换新的 access token。

为什么 access 用 JWT 而不落库：验证它不需要查库，
而店里断网时 API 仍要能快速响应本地请求。
为什么 refresh 必须落库：**要能吊销**。iPad 丢了，删掉 session 行即可。
"""

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError

_ph = PasswordHasher()

JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALG = "HS256"

ACCESS_TTL = timedelta(minutes=15)

# 员工会话必须长 —— 高峰期在油腻的 iPad 上重新打密码是不可能被接受的，
# 强推只会让员工彻底放弃使用这个系统。
REFRESH_TTL_STAFF = timedelta(days=30)
# 老板走公网暴露的入口，寿命必须短
REFRESH_TTL_ADMIN = timedelta(hours=12)


def hash_password(raw: str) -> str:
    return _ph.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    try:
        _ph.verify(hashed, raw)
        return True
    except (VerifyMismatchError, VerificationError):
        return False


def new_refresh_token() -> tuple[str, str]:
    """返回 (明文, 哈希)。明文只在签发这一刻存在，之后服务端只有哈希。"""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    """refresh token 是高熵随机串，不需要 argon2 那种慢哈希
    （慢哈希是为了扛住对**低熵密码**的暴力破解）。SHA-256 足够，
    而且每次同步都要查它，必须快。"""
    return hashlib.sha256(raw.encode()).hexdigest()


def refresh_ttl_for(role: str) -> timedelta:
    return REFRESH_TTL_ADMIN if role == "admin" else REFRESH_TTL_STAFF


def create_access_token(user_id: int, username: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + ACCESS_TTL).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_access_token(token: str) -> dict:
    """过期或被篡改都会抛 jwt 的异常，由调用方转成 401。"""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
