"""Password hashing and token issuing.

Two kinds of token, an order of magnitude apart in lifetime:

  access token   -- a JWT, 15 minutes, never stored. Sent with every request.
  refresh token  -- a random string; only its **hash** is stored. Buys new access tokens.

Why the access token is a JWT and not stored: verifying it needs no database
round trip, and the API has to answer local requests quickly when the store's network is down.
Why the refresh token must be stored: **it has to be revocable**. If an iPad walks, delete the session row.
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

# Staff sessions have to be long -- retyping a password on a greasy iPad at
# peak is not something anyone will accept, and forcing it makes people abandon the system.
REFRESH_TTL_STAFF = timedelta(days=30)
# The owner's entry point is exposed to the public internet, so it stays short
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
    """Returns (plaintext, hash). The plaintext exists only at this moment; afterwards the server has the hash."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    """A refresh token is a high-entropy random string, so it does not need a
    slow hash (those exist to resist brute force against **low-entropy
    passwords**). SHA-256 is enough, and every sync looks it up, so it has to be fast."""
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
    """Expiry or tampering raises out of jwt; the caller turns it into a 401."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
