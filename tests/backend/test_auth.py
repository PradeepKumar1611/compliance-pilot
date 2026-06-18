"""
Tests for auth.py — JWT tokens, password hashing, role-based access.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import HTTPException

from auth import (
    hash_password,
    verify_password,
    create_access_token,
    decode_token,
    require_admin,
    get_current_user,
)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestLoginSuccess:
    """Test that correct credentials return a token with role."""

    @pytest.mark.asyncio
    async def test_login_success(self, app_client):
        resp = await app_client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123"},
        )
        assert resp.status_code == 200
        data = resp.json()
        # Auth is cookie-based: tokens are set as httpOnly cookies, not in the body.
        assert resp.cookies.get("access_token")
        assert resp.cookies.get("csrf_token")
        assert data["role"] == "admin"
        assert data["username"] == "admin"
        assert data["username"] == "admin"


class TestJWTTokenValidates:
    """Test that create_access_token creates a valid token whose decoded data matches."""

    def test_jwt_token_validates(self):
        payload = {"sub": "testuser", "role": "user"}
        token = create_access_token(payload)
        decoded = decode_token(token)
        assert decoded["sub"] == "testuser"
        assert decoded["role"] == "user"
        assert "exp" in decoded


class TestHashPassword:
    """Test that hashed password verifies correctly."""

    def test_hash_password(self):
        plain = "my_secret_password"
        hashed = hash_password(plain)
        assert hashed != plain
        assert verify_password(plain, hashed) is True

    def test_wrong_password_fails(self):
        hashed = hash_password("correct_password")
        assert verify_password("wrong_password", hashed) is False


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestJWTEdgeCases:
    """Edge cases for JWT handling."""

    def test_token_contains_all_claims(self):
        payload = {"sub": "admin", "role": "admin", "custom": "value"}
        token = create_access_token(payload)
        decoded = decode_token(token)
        assert decoded["sub"] == "admin"
        assert decoded["role"] == "admin"
        assert decoded["custom"] == "value"

    def test_empty_payload(self):
        token = create_access_token({})
        decoded = decode_token(token)
        assert "exp" in decoded


class TestHashEdgeCases:
    """Edge cases for password hashing."""

    def test_hash_empty_password(self):
        hashed = hash_password("")
        assert verify_password("", hashed) is True
        assert verify_password("notempty", hashed) is False

    def test_hash_unicode_password(self):
        pwd = "\u00e9\u00e0\u00fc\u00f1\u00f6"
        hashed = hash_password(pwd)
        assert verify_password(pwd, hashed) is True


# ---------------------------------------------------------------------------
# Failure cases
# ---------------------------------------------------------------------------


class TestLoginWrongPassword:
    """Test that wrong password returns 401."""

    @pytest.mark.asyncio
    async def test_login_wrong_password(self, app_client):
        resp = await app_client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "wrongpassword"},
        )
        assert resp.status_code == 401
        assert "Invalid credentials" in resp.json()["detail"]


class TestLoginNonexistentUser:
    """Test that nonexistent user returns 401."""

    @pytest.mark.asyncio
    async def test_login_nonexistent_user(self, app_client):
        resp = await app_client.post(
            "/api/auth/login",
            json={"username": "nouser", "password": "any"},
        )
        assert resp.status_code == 401
        assert "Invalid credentials" in resp.json()["detail"]


class TestAdminOnlyRejectsUser:
    """Test that require_admin raises 403 for a user with role 'user'."""

    @pytest.mark.asyncio
    async def test_admin_only_rejects_user(self, app_client):
        """Regular user gets 403 on admin-only endpoints."""
        # Create a regular user via admin (cookie auth + CSRF header).
        await app_client.post(
            "/api/auth/login", json={"username": "admin", "password": "admin123"}
        )
        admin_csrf = app_client.cookies.get("csrf_token")
        await app_client.post(
            "/api/users",
            json={"username": "regularuser", "password": "password123", "role": "user"},
            headers={"X-CSRF-Token": admin_csrf},
        )

        # Re-login as the regular user (overwrites cookies on the client jar).
        await app_client.post(
            "/api/auth/login", json={"username": "regularuser", "password": "password123"}
        )
        resp = await app_client.get("/api/settings")
        assert resp.status_code == 403


class TestInvalidToken:
    """Test that an invalid JWT token is rejected."""

    def test_decode_invalid_token(self):
        from jose.exceptions import JWTError
        with pytest.raises(JWTError):
            decode_token("not.a.valid.token")
