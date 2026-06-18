"""
Tests for main.py API routes — full integration tests using app_client.
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from io import BytesIO


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestHealthCheck:
    """GET /api/health returns 200."""

    @pytest.mark.asyncio
    async def test_health_check(self, app_client):
        resp = await app_client.get("/api/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "timestamp" in data


class TestLoginFlow:
    """POST /api/auth/login with admin/admin123 returns token."""

    @pytest.mark.asyncio
    async def test_login_flow(self, app_client):
        resp = await app_client.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin123"},
        )
        assert resp.status_code == 200
        data = resp.json()
        # Cookie-based auth: token cookies set, not returned in the body.
        assert resp.cookies.get("access_token")
        assert data["role"] == "admin"
        assert data["username"] == "admin"


class TestDashboardStats:
    """GET /api/dashboard/stats returns expected keys."""

    @pytest.mark.asyncio
    async def test_dashboard_stats(self, app_client, auth_headers):
        resp = await app_client.get("/api/dashboard/stats", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "total_kb_docs" in data
        assert "total_questionnaires" in data
        assert "auto_filled_today" in data
        assert "flagged_today" in data


class TestKBUploadAndList:
    """POST upload a file, then GET /api/kb/documents to verify it appears."""

    @pytest.mark.asyncio
    async def test_kb_upload_and_list(self, app_client, auth_headers, tmp_path):
        # Create a small DOCX file for upload
        from docx import Document
        doc = Document()
        doc.add_paragraph("Test policy content.")
        file_path = tmp_path / "test_policy.docx"
        doc.save(str(file_path))

        # Mock the background task so it doesn't actually run
        with patch("main._ingest_background", new_callable=AsyncMock):
            with open(file_path, "rb") as f:
                resp = await app_client.post(
                    "/api/kb/upload",
                    headers=auth_headers,
                    files={"file": ("test_policy.docx", f, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
                )

            assert resp.status_code == 200
            data = resp.json()
            assert data["filename"] == "test_policy.docx"
            assert data["status"] == "processing"

        # List documents
        resp = await app_client.get("/api/kb/documents", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        docs = data["items"]
        assert len(docs) >= 1
        assert any(d["filename"] == "test_policy.docx" for d in docs)


class TestQuestionnaireFlow:
    """POST upload questionnaire, verify job created and queryable."""

    @pytest.mark.asyncio
    async def test_questionnaire_flow(self, app_client, auth_headers, sample_docx):
        # Mock extract_questions and background processing
        with patch("main.extract_questions") as mock_extract, \
             patch("main._process_questionnaire_background", new_callable=AsyncMock):
            mock_extract.return_value = [
                {"question_text": "What is your policy?", "location_info": {"type": "docx_table", "table_index": 0, "row_index": 1, "answer_col": 1}},
            ]

            with open(sample_docx, "rb") as f:
                resp = await app_client.post(
                    "/api/questionnaire/upload",
                    headers=auth_headers,
                    files={"file": ("questionnaire.docx", f, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
                )

            assert resp.status_code == 200
            data = resp.json()
            assert "job_id" in data
            assert data["question_count"] == 1
            assert data["status"] == "queued"

            job_id = data["job_id"]

        # Query the job
        resp = await app_client.get(f"/api/questionnaire/jobs/{job_id}", headers=auth_headers)
        assert resp.status_code == 200
        job_data = resp.json()
        assert job_data["id"] == job_id


class TestSettingsCRUD:
    """GET /api/settings, PUT /api/settings, verify changes persist."""

    @pytest.mark.asyncio
    async def test_settings_crud(self, app_client, auth_headers):
        # GET defaults
        resp = await app_client.get("/api/settings", headers=auth_headers)
        assert resp.status_code == 200
        original = resp.json()
        assert "ollama_url" in original
        assert "llm_model" in original

        # PUT update
        resp = await app_client.put(
            "/api/settings",
            headers=auth_headers,
            json={"llm_model": "llama3.1", "max_chunks": 10},
        )
        assert resp.status_code == 200

        # Verify changes persisted
        resp = await app_client.get("/api/settings", headers=auth_headers)
        assert resp.status_code == 200
        updated = resp.json()
        assert updated["llm_model"] == "llama3.1"
        assert updated["max_chunks"] == 10


class TestUserManagement:
    """POST create user, GET list users, DELETE user."""

    @pytest.mark.asyncio
    async def test_user_management(self, app_client, auth_headers):
        # Create user
        resp = await app_client.post(
            "/api/users",
            headers=auth_headers,
            json={"username": "newuser", "password": "password123", "role": "user"},
        )
        assert resp.status_code == 201
        user_data = resp.json()
        user_id = user_data["id"]
        assert user_data["username"] == "newuser"
        assert user_data["role"] == "user"

        # List users
        resp = await app_client.get("/api/users", headers=auth_headers)
        assert resp.status_code == 200
        users = resp.json()
        assert any(u["username"] == "newuser" for u in users)

        # Delete user
        resp = await app_client.delete(f"/api/users/{user_id}", headers=auth_headers)
        assert resp.status_code == 200

        # Verify deleted
        resp = await app_client.get("/api/users", headers=auth_headers)
        users = resp.json()
        assert not any(u["username"] == "newuser" for u in users)


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestDashboardWithNoData:
    """Dashboard stats should return zeros when no data exists."""

    @pytest.mark.asyncio
    async def test_dashboard_stats_empty(self, app_client, auth_headers):
        resp = await app_client.get("/api/dashboard/stats", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_kb_docs"] == 0
        assert data["total_questionnaires"] == 0
        assert data["auto_filled_today"] == 0
        assert data["flagged_today"] == 0


class TestDuplicateUserCreation:
    """Creating a user with existing username should fail."""

    @pytest.mark.asyncio
    async def test_duplicate_user(self, app_client, auth_headers):
        # admin already exists
        resp = await app_client.post(
            "/api/users",
            headers=auth_headers,
            json={"username": "admin", "password": "password123", "role": "user"},
        )
        assert resp.status_code == 400
        assert "already exists" in resp.json()["detail"]


class TestInvalidRoleCreation:
    """Creating a user with invalid role should fail validation."""

    @pytest.mark.asyncio
    async def test_invalid_role(self, app_client, auth_headers):
        resp = await app_client.post(
            "/api/users",
            headers=auth_headers,
            json={"username": "newu", "password": "password123", "role": "superadmin"},
        )
        # role is constrained to a Literal -> 422 Unprocessable Entity
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Failure cases
# ---------------------------------------------------------------------------


class TestUnauthorizedAccess:
    """Requests without token return 401 or 403."""

    @pytest.mark.asyncio
    async def test_unauthorized_access(self, app_client):
        # Protected endpoints without auth headers
        resp = await app_client.get("/api/dashboard/stats")
        assert resp.status_code in (401, 403)

        resp = await app_client.get("/api/kb/documents")
        assert resp.status_code in (401, 403)

        resp = await app_client.get("/api/settings")
        assert resp.status_code in (401, 403)

        resp = await app_client.get("/api/audit")
        assert resp.status_code in (401, 403)


class TestAdminOnlyEndpoints:
    """User role gets 403 on admin-only endpoints."""

    @pytest.mark.asyncio
    async def test_admin_only_endpoints(self, app_client, auth_headers):
        # First create a regular user
        resp = await app_client.post(
            "/api/users",
            headers=auth_headers,
            json={"username": "regularuser", "password": "password123", "role": "user"},
        )
        assert resp.status_code == 201

        # Login as regular user (overwrites cookies on the client jar)
        resp = await app_client.post(
            "/api/auth/login",
            json={"username": "regularuser", "password": "password123"},
        )
        assert resp.status_code == 200
        user_csrf = app_client.cookies.get("csrf_token")
        user_headers = {"X-CSRF-Token": user_csrf} if user_csrf else {}

        # Try admin-only endpoints (now authenticated as the regular user)
        resp = await app_client.get("/api/settings")
        assert resp.status_code == 403

        resp = await app_client.get("/api/users")
        assert resp.status_code == 403

        resp = await app_client.post(
            "/api/users",
            headers=user_headers,
            json={"username": "xuser", "password": "password123", "role": "user"},
        )
        assert resp.status_code == 403


class TestUploadUnsupportedFormat:
    """Uploading unsupported file format returns 400."""

    @pytest.mark.asyncio
    async def test_upload_unsupported_kb(self, app_client, auth_headers, tmp_path):
        path = tmp_path / "file.xyz"
        path.write_text("some content")

        with open(path, "rb") as f:
            resp = await app_client.post(
                "/api/kb/upload",
                headers=auth_headers,
                files={"file": ("file.xyz", f, "application/octet-stream")},
            )

        assert resp.status_code == 400
        assert "Unsupported" in resp.json()["detail"]
