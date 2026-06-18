"""
JWT authentication + bcrypt password hashing.

Auth is cookie-based: a short-lived httpOnly ``access_token`` plus a longer-lived
httpOnly ``refresh_token``, with a non-httpOnly ``csrf_token`` for double-submit
CSRF protection. A ``Authorization: Bearer`` header is still accepted as a
transition fallback.
"""

import secrets
from datetime import datetime, timedelta
from typing import Optional, Union

from fastapi import Depends, HTTPException, Request, Response
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select

from config import settings

# ---------------------------------------------------------------------------
# Password hashing
# ---------------------------------------------------------------------------

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------

ACCESS_COOKIE = "access_token"
REFRESH_COOKIE = "refresh_token"
CSRF_COOKIE = "csrf_token"


def create_access_token(data: dict, expires_delta: Union[timedelta, None] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_MINUTES)
    )
    to_encode.update({"exp": expire, "type": "access"})
    return jwt.encode(to_encode, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    to_encode.update(
        {
            "exp": datetime.utcnow() + timedelta(days=settings.REFRESH_TOKEN_DAYS),
            "type": "refresh",
        }
    )
    return jwt.encode(to_encode, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])


# ---------------------------------------------------------------------------
# Cookies
# ---------------------------------------------------------------------------

def _cookie_kwargs(max_age: int) -> dict:
    return dict(
        secure=settings.COOKIE_SECURE,
        samesite=settings.COOKIE_SAMESITE,
        max_age=max_age,
        path="/",
    )


def set_auth_cookies(response: Response, username: str, role: str) -> str:
    """Set access/refresh (httpOnly) + csrf (JS-readable) cookies. Returns csrf token."""
    access = create_access_token({"sub": username, "role": role})
    refresh = create_refresh_token({"sub": username, "role": role})
    csrf = secrets.token_urlsafe(32)
    response.set_cookie(
        ACCESS_COOKIE, access, httponly=True, **_cookie_kwargs(settings.ACCESS_TOKEN_MINUTES * 60)
    )
    response.set_cookie(
        REFRESH_COOKIE, refresh, httponly=True, **_cookie_kwargs(settings.REFRESH_TOKEN_DAYS * 86400)
    )
    # CSRF cookie must be readable by JS so the SPA can echo it in a header.
    response.set_cookie(
        CSRF_COOKIE, csrf, httponly=False, **_cookie_kwargs(settings.REFRESH_TOKEN_DAYS * 86400)
    )
    return csrf


def clear_auth_cookies(response: Response) -> None:
    for name in (ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE):
        response.delete_cookie(name, path="/")


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------

def _extract_token(request: Request) -> Optional[str]:
    token = request.cookies.get(ACCESS_COOKIE)
    if token:
        return token
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    return None


async def get_current_user(request: Request):
    """Resolve the User from the access-token cookie (or Bearer header)."""
    from models import async_session, User

    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(token)
        if payload.get("type") == "refresh":
            raise HTTPException(status_code=401, detail="Invalid token")
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

    async with async_session() as session:
        result = await session.execute(select(User).where(User.username == username))
        user = result.scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        return user


async def require_admin(user=Depends(get_current_user)):
    """Same as get_current_user but raises 403 if not admin."""
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
