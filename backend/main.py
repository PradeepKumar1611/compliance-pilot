"""
Compliance Pilot Backend — FastAPI Application
All routes, CORS, startup events
"""

import os

# Remove proxy env vars — Ollama/Qdrant are local, proxy breaks httpx connections
for _proxy_key in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
    os.environ.pop(_proxy_key, None)

import asyncio
import io
import csv
import json
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Literal

from fastapi import (
    FastAPI, Depends, HTTPException, UploadFile, File,
    Query, BackgroundTasks, status, Form, Request, Response
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, func, and_, desc
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings, is_internal_url
from models import (
    async_session, init_db, User, AuditLog, KBDocument,
    KBVersion, ProcessingJob, Settings as SettingsModel, SystemState
)
from auth import (
    verify_password, create_access_token, get_current_user,
    require_admin, hash_password, set_auth_cookies, clear_auth_cookies,
    decode_token, REFRESH_COOKIE, CSRF_COOKIE, ACCESS_COOKIE,
)
from jose import JWTError
from ingest import ingest_document, get_current_version, create_new_version, get_collection_name
from retriever import query_knowledge_base
from extractor import extract_questions
from filler import fill_document
from translator import detect_language, translate_to_english, translate_from_english
from audit_logger import log_answer, get_audit_logs, export_audit_csv
from job_manager import (
    create_job, update_job_status, get_job, get_user_jobs
)

# ---------------------------------------------------------------------------
# App & CORS
# ---------------------------------------------------------------------------

app = FastAPI(title="Compliance Pilot", version="1.0.0")

# Job cancellation + batch-ingestion state are persisted in the DB
# (ProcessingJob.cancel_requested and the system_state table) so they survive
# restarts and are correct across workers.

_INGEST_KEY = "ingestion"
_INGEST_DEFAULT = {
    "running": False, "started_at": None, "cancel": False,
    "current_doc": "", "processed": 0, "total": 0,
}
_INGEST_STALE_SECONDS = 7200  # auto-release a lock stuck longer than this


async def _read_ingestion_state() -> dict:
    async with async_session() as db:
        row = (
            await db.execute(select(SystemState).where(SystemState.key == _INGEST_KEY))
        ).scalar_one_or_none()
        state = dict(_INGEST_DEFAULT)
        if row and row.value:
            try:
                state.update(json.loads(row.value))
            except (ValueError, TypeError):
                pass
        return state


async def _write_ingestion_state(**updates) -> dict:
    async with async_session() as db:
        row = (
            await db.execute(select(SystemState).where(SystemState.key == _INGEST_KEY))
        ).scalar_one_or_none()
        state = dict(_INGEST_DEFAULT)
        if row and row.value:
            try:
                state.update(json.loads(row.value))
            except (ValueError, TypeError):
                pass
        state.update(updates)
        if row:
            row.value = json.dumps(state)
            row.updated_at = datetime.utcnow()
        else:
            db.add(SystemState(key=_INGEST_KEY, value=json.dumps(state)))
        await db.commit()
        return state


async def _ingestion_running_state() -> dict:
    """Current ingestion state, auto-releasing a stale lock."""
    state = await _read_ingestion_state()
    if (
        state["running"]
        and state["started_at"]
        and (time.time() - state["started_at"] > _INGEST_STALE_SECONDS)
    ):
        print("[BATCH] Ingestion lock stale — auto-resetting", flush=True)
        state = await _write_ingestion_state(running=False, started_at=None, cancel=False)
    return state

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# CSRF double-submit protection for cookie-authenticated mutating requests.
# Bearer-header clients (transition / API scripts) are unaffected.
_CSRF_EXEMPT = {"/api/auth/login", "/api/auth/refresh", "/api/auth/logout"}


@app.middleware("http")
async def csrf_protect(request: Request, call_next):
    if request.method in ("POST", "PUT", "DELETE", "PATCH"):
        cookie_auth = request.cookies.get(ACCESS_COOKIE) is not None
        if cookie_auth and request.url.path not in _CSRF_EXEMPT:
            header = request.headers.get("x-csrf-token")
            cookie = request.cookies.get(CSRF_COOKIE)
            if not header or not cookie or header != cookie:
                from fastapi.responses import JSONResponse
                return JSONResponse(
                    status_code=403, content={"detail": "CSRF token missing or invalid"}
                )
    return await call_next(request)

_PROJECT_ROOT = Path(__file__).parent.parent
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", str(_PROJECT_ROOT / "uploads")))
OUTPUT_DIR = Path(os.getenv("OUTPUT_DIR", str(_PROJECT_ROOT / "outputs")))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup():
    # Validate configuration early; fatal problems raise, soft problems warn.
    for _warn in settings.validate():
        print(f"[CONFIG WARNING] {_warn}")

    await init_db()

    # Pre-download sparse embedding model (BM42) for hybrid search
    try:
        from fastembed import SparseTextEmbedding
        SparseTextEmbedding(model_name="Qdrant/bm42-all-minilm-l6-v2-attentions")
        print("Sparse embedding model (BM42) ready")
    except Exception as e:
        print(f"Warning: Could not load sparse embedding model: {e}")


# ---------------------------------------------------------------------------
# Dependency: DB session
# ---------------------------------------------------------------------------

async def get_db():
    async with async_session() as session:
        yield session


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_settings_dict(db: AsyncSession) -> dict:
    """Load all runtime settings from SQLite, falling back to config defaults."""
    result = await db.execute(select(SettingsModel))
    rows = result.scalars().all()
    db_settings = {r.key: r.value for r in rows}
    return {
        "llm_provider": db_settings.get("llm_provider", settings.LLM_PROVIDER),
        "ollama_url": db_settings.get("ollama_url", settings.OLLAMA_URL),
        "llm_model": db_settings.get("llm_model", settings.LLM_MODEL),
        "embed_model": db_settings.get("embed_model", settings.EMBED_MODEL),
        "embed_url": db_settings.get("embed_url", settings.EMBED_URL),
        "confidence_auto_fill": float(
            db_settings.get("confidence_auto_fill", settings.CONFIDENCE_AUTO_FILL)
        ),
        "confidence_flag": float(
            db_settings.get("confidence_flag", settings.CONFIDENCE_FLAG)
        ),
        "max_chunks": int(
            db_settings.get("max_chunks", settings.MAX_CHUNKS)
        ),
        "hybrid_alpha": float(
            db_settings.get("hybrid_alpha", settings.HYBRID_ALPHA)
        ),
        "qdrant_url": db_settings.get("qdrant_url", settings.QDRANT_URL),
        "max_chunk_chars": int(
            db_settings.get("max_chunk_chars", settings.MAX_CHUNK_CHARS)
        ),
        "embed_concurrency": int(
            db_settings.get("embed_concurrency", settings.EMBED_CONCURRENCY)
        ),
        "chunk_overlap": int(
            db_settings.get("chunk_overlap", settings.CHUNK_OVERLAP)
        ),
        "ingestion_timeout": int(
            db_settings.get("ingestion_timeout", settings.INGESTION_TIMEOUT)
        ),
        "query_expansion_enabled": db_settings.get(
            "query_expansion_enabled", str(settings.QUERY_EXPANSION_ENABLED)
        ) in (True, "True", "true", "1"),
        "reranking_enabled": db_settings.get(
            "reranking_enabled", str(settings.RERANKING_ENABLED)
        ) in (True, "True", "true", "1"),
    }


# --- Login rate limiting (in-process; per username+IP) ---
# NOTE: single-process only. For multi-worker, back this with Redis.
_LOGIN_FAILURES: dict[str, list[float]] = {}
_LOGIN_MAX_FAILURES = 5
_LOGIN_WINDOW_SECONDS = 300


def _login_rate_check(key: str) -> None:
    now = time.time()
    hits = [t for t in _LOGIN_FAILURES.get(key, []) if now - t < _LOGIN_WINDOW_SECONDS]
    _LOGIN_FAILURES[key] = hits
    if len(hits) >= _LOGIN_MAX_FAILURES:
        raise HTTPException(
            status_code=429,
            detail="Too many failed login attempts. Try again in a few minutes.",
        )


def _login_record_failure(key: str) -> None:
    _LOGIN_FAILURES.setdefault(key, []).append(time.time())


def _login_clear(key: str) -> None:
    _LOGIN_FAILURES.pop(key, None)


def _safe_name(name: Optional[str]) -> str:
    """Reduce an uploaded filename to a safe basename (defeats path traversal)."""
    base = Path(name or "").name  # strips any directory components
    base = base.replace("\x00", "").strip()
    # keep it conservative — alnum, dash, underscore, dot, space
    base = "".join(c for c in base if c.isalnum() or c in "-_. ").strip()
    return base or "upload"


def _save_upload(upload: UploadFile, dest_dir: Path) -> Path:
    """Save an uploaded file and return the path.

    Sanitizes the filename to a basename so it cannot escape dest_dir, and
    enforces MAX_UPLOAD_MB while streaming to disk.
    """
    unique = f"{uuid.uuid4().hex}_{_safe_name(upload.filename)}"
    dest = dest_dir / unique
    max_bytes = settings.MAX_UPLOAD_MB * 1024 * 1024
    written = 0
    with open(dest, "wb") as f:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                f.close()
                dest.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=413,
                    detail=f"File exceeds the {settings.MAX_UPLOAD_MB} MB upload limit",
                )
            f.write(chunk)
    return dest


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

USERNAME_RE = r"^[A-Za-z0-9_.@-]{3,100}$"


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=200)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


class CreateUserRequest(BaseModel):
    username: str = Field(pattern=USERNAME_RE)
    password: str = Field(min_length=8, max_length=200)
    role: Literal["user", "admin"] = "user"


class UpdateRoleRequest(BaseModel):
    role: Literal["user", "admin"]


class ResetPasswordRequest(BaseModel):
    new_password: str = Field(min_length=8, max_length=200)


class SettingsUpdateRequest(BaseModel):
    llm_provider: Optional[Literal["claude_code", "ollama"]] = None
    ollama_url: Optional[str] = None
    llm_model: Optional[str] = Field(default=None, max_length=200)
    embed_model: Optional[str] = Field(default=None, max_length=200)
    embed_url: Optional[str] = None
    confidence_auto_fill: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    confidence_flag: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    max_chunks: Optional[int] = Field(default=None, ge=1, le=50)
    hybrid_alpha: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    max_chunk_chars: Optional[int] = Field(default=None, ge=100, le=10000)
    embed_concurrency: Optional[int] = Field(default=None, ge=1, le=128)
    chunk_overlap: Optional[int] = Field(default=None, ge=0, le=2000)
    ingestion_timeout: Optional[int] = Field(default=None, ge=1, le=86400)
    query_expansion_enabled: Optional[bool] = None
    reranking_enabled: Optional[bool] = None

    @field_validator("ollama_url", "embed_url")
    @classmethod
    def _validate_internal_url(cls, v):
        if v is None or v == "":
            return v
        if not is_internal_url(v):
            raise ValueError(
                "URL must be http(s) and resolve to a loopback/private host "
                "(SSRF protection). Add the host to SSRF_HOST_ALLOWLIST if intended."
            )
        return v

    @field_validator("confidence_flag")
    @classmethod
    def _flag_below_autofill(cls, v, info):
        af = info.data.get("confidence_auto_fill")
        if v is not None and af is not None and not (v < af):
            raise ValueError("confidence_flag must be < confidence_auto_fill")
        return v


class TestConnectionRequest(BaseModel):
    ollama_url: str = ""
    model: str = ""
    model_type: str = "llm"  # "llm", "embedding", or "claude_code"


# ---------------------------------------------------------------------------
# AUTH ROUTES
# ---------------------------------------------------------------------------

@app.post("/api/auth/login")
async def login(
    req: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    client_ip = request.client.host if request.client else "unknown"
    rl_key = f"{req.username}:{client_ip}"
    _login_rate_check(rl_key)

    result = await db.execute(select(User).where(User.username == req.username))
    user = result.scalar_one_or_none()
    if not user or not verify_password(req.password, user.hashed_password):
        _login_record_failure(rl_key)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    _login_clear(rl_key)

    # Auth via httpOnly cookies (access + refresh) + a JS-readable CSRF token.
    set_auth_cookies(response, user.username, user.role)
    return {
        "role": user.role,
        "must_change_password": user.must_change_password,
        "username": user.username,
    }


@app.post("/api/auth/refresh")
async def refresh_token(request: Request, response: Response):
    """Issue a new access token from a valid refresh-token cookie."""
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(status_code=401, detail="No refresh token")
    try:
        payload = decode_token(token)
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid refresh token")
        username = payload.get("sub")
        role = payload.get("role", "user")
        if not username:
            raise HTTPException(status_code=401, detail="Invalid refresh token")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    set_auth_cookies(response, username, role)
    return {"message": "refreshed", "username": username, "role": role}


@app.post("/api/auth/logout")
async def logout(response: Response):
    clear_auth_cookies(response)
    return {"message": "logged out"}


@app.post("/api/auth/change-password")
async def change_password(
    req: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one()
    if not verify_password(req.current_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    user.hashed_password = hash_password(req.new_password)
    user.must_change_password = False
    await db.commit()
    return {"message": "Password changed successfully"}


@app.get("/api/auth/me")
async def get_me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id,
        "username": current_user.username,
        "role": current_user.role,
        "must_change_password": current_user.must_change_password,
    }


# ---------------------------------------------------------------------------
# USER MANAGEMENT (admin only)
# ---------------------------------------------------------------------------

@app.get("/api/users")
async def list_users(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User))
    users = result.scalars().all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "role": u.role,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in users
    ]


@app.post("/api/users", status_code=201)
async def create_user(
    req: CreateUserRequest,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(select(User).where(User.username == req.username))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already exists")
    if req.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'user'")
    user = User(
        username=req.username,
        hashed_password=hash_password(req.password),
        role=req.role,
        must_change_password=False,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return {"id": user.id, "username": user.username, "role": user.role}


@app.put("/api/users/{user_id}/role")
async def update_user_role(
    user_id: int,
    req: UpdateRoleRequest,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if req.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'user'")
    user.role = req.role
    await db.commit()
    return {"message": "Role updated"}


@app.post("/api/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: int,
    req: ResetPasswordRequest,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.hashed_password = hash_password(req.new_password)
    user.must_change_password = True
    await db.commit()
    return {"message": "Password reset"}


@app.delete("/api/users/{user_id}")
async def delete_user(
    user_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    await db.delete(user)
    await db.commit()
    return {"message": "User deleted"}


# ---------------------------------------------------------------------------
# KNOWLEDGE BASE ROUTES
# ---------------------------------------------------------------------------

@app.get("/api/kb/version")
async def get_kb_version(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    version = await get_current_version(db)
    return {"current_version": version}


@app.get("/api/kb/versions")
async def list_kb_versions(
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all KB versions with metadata."""
    result = await db.execute(
        select(KBVersion).order_by(desc(KBVersion.version))
    )
    versions = result.scalars().all()

    # Update doc counts from actual data
    version_list = []
    for v in versions:
        count_result = await db.execute(
            select(func.count(KBDocument.id)).where(
                KBDocument.version == v.version,
                KBDocument.status == "ready",
            )
        )
        ready_count = count_result.scalar() or 0
        version_list.append({
            "version": v.version,
            "name": v.name,
            "embed_model": v.embed_model,
            "doc_count": ready_count,
            "is_active": v.is_active,
            "created_at": v.created_at.isoformat() if v.created_at else None,
        })

    active = next((v["version"] for v in version_list if v["is_active"]), None)
    return {"versions": version_list, "active_version": active}


class VersionNameRequest(BaseModel):
    name: str


@app.put("/api/kb/versions/{version_id}/name")
async def rename_kb_version(
    version_id: int,
    req: VersionNameRequest,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Rename a KB version."""
    result = await db.execute(
        select(KBVersion).where(KBVersion.version == version_id)
    )
    kv = result.scalar_one_or_none()
    if not kv:
        raise HTTPException(status_code=404, detail="Version not found")
    kv.name = req.name
    await db.commit()
    return {"message": f"Version {version_id} renamed to '{req.name}'"}


@app.post("/api/kb/versions/{version_id}/activate")
async def activate_kb_version(
    version_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Set a version as the active version for queries."""
    result = await db.execute(
        select(KBVersion).where(KBVersion.version == version_id)
    )
    kv = result.scalar_one_or_none()
    if not kv:
        raise HTTPException(status_code=404, detail="Version not found")

    # Deactivate all, then activate this one
    await db.execute(
        KBVersion.__table__.update().values(is_active=False)
    )
    kv.is_active = True

    # Also update settings for backward compat
    settings_result = await db.execute(
        select(SettingsModel).where(SettingsModel.key == "kb_version")
    )
    setting = settings_result.scalar_one_or_none()
    if setting:
        setting.value = str(version_id)
    else:
        db.add(SettingsModel(key="kb_version", value=str(version_id)))

    await db.commit()
    return {"message": f"Version {version_id} is now active"}


@app.post("/api/kb/version")
async def bump_kb_version(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    s = await _get_settings_dict(db)
    new_ver = await create_new_version(db, embed_model=s["embed_model"])
    return {"new_version": new_ver}


@app.post("/api/kb/upload")
async def upload_kb_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    is_questionnaire: bool = Form(False),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    import zipfile

    allowed = {".pdf", ".docx", ".xlsx", ".txt", ".json", ".html", ".htm", ".csv", ".md"}
    ext = Path(file.filename).suffix.lower()

    if ext == ".zip":
        # Handle ZIP: extract and ingest each supported file
        zip_path = _save_upload(file, UPLOAD_DIR)
        version = await get_current_version(db)
        results = []

        extract_dir = UPLOAD_DIR / f"zip_{uuid.uuid4().hex}"
        extract_dir.mkdir(parents=True, exist_ok=True)

        with zipfile.ZipFile(str(zip_path), "r") as zf:
            # Guard against zip-slip: only extract members that stay inside extract_dir.
            base = extract_dir.resolve()
            for member in zf.namelist():
                target = (extract_dir / member).resolve()
                if not target.is_relative_to(base):
                    print(f"[ZIP] Skipping unsafe member: {member}")
                    continue
                zf.extract(member, str(extract_dir))

        # Walk extracted files
        extracted_files = []
        for root, dirs, files in os.walk(str(extract_dir)):
            for fname in files:
                fpath = os.path.join(root, fname)
                fext = Path(fname).suffix.lower()
                if fext in allowed and not fname.startswith("._") and not fname.startswith("__"):
                    extracted_files.append((fpath, fname))

        for fpath, fname in extracted_files:
            # Rename to filled_* prefix for questionnaire uploads
            display_name = fname
            if is_questionnaire and not display_name.startswith("filled_"):
                display_name = f"filled_{display_name}"

            kb_doc = KBDocument(
                filename=display_name,
                version=version,
                chunk_count=0,
                status="processing",
                file_path=fpath,
                is_questionnaire=is_questionnaire,
            )
            db.add(kb_doc)
            await db.commit()
            await db.refresh(kb_doc)

            results.append({
                "id": kb_doc.id,
                "filename": display_name,
                "version": version,
                "status": "processing",
            })

        # Process all extracted files with controlled parallelism
        batch = [(r["id"], fpath, r["filename"], version, is_questionnaire)
                 for r, (fpath, _) in zip(results, extracted_files)]
        background_tasks.add_task(_retry_batch, batch)

        return {
            "zip": True,
            "total_files": len(extracted_files),
            "results": results,
        }

    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {ext}. Supported: {', '.join(sorted(allowed))} or .zip")

    try:
        file_path = _save_upload(file, UPLOAD_DIR)
        version = await get_current_version(db)

        # Rename to filled_* prefix for questionnaire uploads
        display_name = file.filename
        if is_questionnaire and not display_name.startswith("filled_"):
            display_name = f"filled_{display_name}"

        kb_doc = KBDocument(
            filename=display_name,
            version=version,
            chunk_count=0,
            status="processing",
            file_path=str(file_path),
            is_questionnaire=is_questionnaire,
        )
        db.add(kb_doc)
        await db.commit()
        await db.refresh(kb_doc)

        background_tasks.add_task(
            _ingest_background, kb_doc.id, str(file_path), display_name, version, is_questionnaire
        )

        return {
            "id": kb_doc.id,
            "filename": kb_doc.filename,
            "version": version,
            "status": "processing",
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


async def _ingest_background(doc_id: int, file_path: str, filename: str, version: int, is_questionnaire: bool = False):
    async with async_session() as db:
        s = await _get_settings_dict(db)
        try:
            embed_url = s.get("embed_url") or s["ollama_url"]
            chunk_count = await ingest_document(
                file_path, filename, version, db,
                s["qdrant_url"], embed_url, s["embed_model"],
                llm_model=s["llm_model"],
                max_chunk_chars=s.get("max_chunk_chars", 1000),
                embed_concurrency=s.get("embed_concurrency", 1),
                chunk_overlap=s.get("chunk_overlap", 150),
                is_questionnaire=is_questionnaire,
                llm_provider=s.get("llm_provider", "claude_code"),
                llm_ollama_url=s.get("ollama_url", "http://localhost:11434"),
            )
            result = await db.execute(select(KBDocument).where(KBDocument.id == doc_id))
            doc = result.scalar_one()
            doc.chunk_count = chunk_count
            doc.status = "ready"
            await db.commit()
        except Exception as e:
            result = await db.execute(select(KBDocument).where(KBDocument.id == doc_id))
            doc = result.scalar_one()
            doc.status = "failed"
            doc.error_message = str(e)[:500]
            await db.commit()
            print(f"Ingest failed for {filename}: {e}")


@app.post("/api/kb/retry-failed")
async def retry_failed_documents(
    background_tasks: BackgroundTasks,
    version: Optional[int] = Query(None),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Re-queue failed/stuck KB documents for ingestion. If version specified, only that version."""
    if (await _ingestion_running_state())["running"]:
        raise HTTPException(status_code=409, detail="Ingestion batch already running. Please wait for it to finish.")

    # Default to current version if not specified
    if version is None:
        version = await get_current_version(db)

    result = await db.execute(
        select(KBDocument).where(
            KBDocument.status.in_(["failed", "processing"]),
            KBDocument.version == version,
        )
    )
    failed_docs = result.scalars().all()

    if not failed_docs:
        return {"message": "No failed documents to retry", "count": 0}

    # Collect docs to retry
    retry_list = []
    for doc in failed_docs:
        if doc.file_path and os.path.exists(doc.file_path):
            doc.status = "processing"
            doc.chunk_count = 0
            doc.error_message = None
            retry_list.append((doc.id, doc.file_path, doc.filename, doc.version, bool(doc.is_questionnaire)))

    await db.commit()

    # Process sequentially in a single background task to avoid flooding Ollama
    background_tasks.add_task(_retry_batch, retry_list)

    return {"message": f"Retrying {len(retry_list)} failed documents", "count": len(retry_list)}


async def _retry_batch(retry_list: list):
    """Process documents sequentially in a thread pool.
    Tracks progress, supports cancellation, configurable timeout.
    State lives in the DB (system_state) so it survives restart / multi-worker."""
    import asyncio

    state = await _ingestion_running_state()
    if state["running"]:
        print("[BATCH] Ingestion already running — skipping", flush=True)
        return

    await _write_ingestion_state(
        running=True, started_at=time.time(), cancel=False,
        current_doc="", processed=0, total=len(retry_list),
    )

    # Load configurable timeout before entering thread
    async with async_session() as _sdb:
        _batch_settings = await _get_settings_dict(_sdb)
    _doc_timeout = int(_batch_settings.get("ingestion_timeout", 600))

    print(f"[BATCH] Starting batch of {len(retry_list)} docs, timeout={_doc_timeout}s", flush=True)

    def _sync_batch():
        # Clear proxy in thread
        for _pk in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
            os.environ.pop(_pk, None)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            for i, item in enumerate(retry_list):
                # Unpack — support both 4-tuple (legacy) and 5-tuple (with is_questionnaire)
                if len(item) >= 5:
                    doc_id, file_path, filename, version, is_qa = item
                else:
                    doc_id, file_path, filename, version = item
                    is_qa = False

                # Check cancel flag (DB-backed)
                if loop.run_until_complete(_read_ingestion_state())["cancel"]:
                    print(f"[BATCH] Cancelled at doc {i}/{len(retry_list)}", flush=True)
                    for remaining in retry_list[i:]:
                        loop.run_until_complete(_mark_doc_failed(remaining[0], "Ingestion cancelled by user"))
                    break

                # Update progress
                loop.run_until_complete(
                    _write_ingestion_state(current_doc=filename, processed=i)
                )

                for attempt in range(2):
                    try:
                        loop.run_until_complete(
                            asyncio.wait_for(
                                _ingest_background(doc_id, file_path, filename, version, is_qa),
                                timeout=_doc_timeout,
                            )
                        )
                        break
                    except asyncio.TimeoutError:
                        print(f"[BATCH] Timeout: {filename} (attempt {attempt+1})", flush=True)
                        loop.run_until_complete(_mark_doc_failed(doc_id, f"Timed out ({_doc_timeout}s)"))
                        break
                    except Exception as e:
                        print(f"[BATCH] Error: {filename} (attempt {attempt+1}): {e}", flush=True)
                        if attempt == 0:
                            import time; time.sleep(2)
                import time; time.sleep(0.1)

            loop.run_until_complete(_write_ingestion_state(processed=len(retry_list)))
        finally:
            loop.close()

    try:
        await asyncio.to_thread(_sync_batch)
    finally:
        await _write_ingestion_state(
            running=False, started_at=None, cancel=False,
            current_doc="", processed=0, total=0,
        )


async def _mark_doc_failed(doc_id: int, error_msg: str):
    """Mark a document as failed in the database."""
    async with async_session() as db:
        result = await db.execute(select(KBDocument).where(KBDocument.id == doc_id))
        doc = result.scalar_one_or_none()
        if doc:
            doc.status = "failed"
            doc.error_message = error_msg[:500]
            await db.commit()


@app.get("/api/kb/ingestion-status")
async def get_ingestion_status(
    _user: User = Depends(get_current_user),
):
    """Get current ingestion batch status."""
    state = await _ingestion_running_state()
    return {
        "running": state["running"],
        "current_doc": state["current_doc"],
        "processed": state["processed"],
        "total": state["total"],
        "started_at": (
            datetime.fromtimestamp(state["started_at"]).isoformat()
            if state["started_at"] else None
        ),
    }


@app.post("/api/kb/cancel-ingestion")
async def cancel_ingestion(
    _admin: User = Depends(require_admin),
):
    """Cancel the currently running ingestion batch."""
    if not (await _ingestion_running_state())["running"]:
        raise HTTPException(status_code=400, detail="No ingestion running")
    await _write_ingestion_state(cancel=True)
    return {"message": "Cancel requested"}


@app.delete("/api/kb/version/{version_id}")
async def delete_kb_version(
    version_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Delete all documents and Qdrant collection for a specific KB version."""
    if (await _ingestion_running_state())["running"]:
        raise HTTPException(status_code=409, detail="Cannot delete version while ingestion is running")

    current = await get_current_version(db)
    if version_id == current:
        raise HTTPException(status_code=400, detail="Cannot delete the current active version")

    # Also protect the version with the most ready docs
    result_max = await db.execute(
        select(KBDocument.version, func.count(KBDocument.id))
        .where(KBDocument.status == "ready")
        .group_by(KBDocument.version)
        .order_by(desc(func.count(KBDocument.id)))
        .limit(1)
    )
    top_version = result_max.first()
    if top_version and top_version[0] == version_id:
        raise HTTPException(status_code=400, detail=f"Cannot delete version {version_id} — it has the most ready documents")

    # Auto-backup before delete
    try:
        backup_result = await backup_kb_version(version_id, _admin=_admin, db=db)
        print(f"[BACKUP] Auto-backup before delete: {backup_result['file']}")
    except Exception as e:
        print(f"[BACKUP] Auto-backup failed (continuing with delete): {e}")

    # Delete documents from DB
    result = await db.execute(
        select(func.count(KBDocument.id)).where(KBDocument.version == version_id)
    )
    count = result.scalar() or 0
    if count == 0:
        raise HTTPException(status_code=404, detail=f"No documents found for version {version_id}")

    await db.execute(
        KBDocument.__table__.delete().where(KBDocument.version == version_id)
    )
    await db.commit()

    # Delete Qdrant collection
    try:
        from qdrant_client import QdrantClient as _QC
        s = await _get_settings_dict(db)
        client = _QC(url=s["qdrant_url"])
        coll_name = get_collection_name(version_id)
        if client.collection_exists(coll_name):
            client.delete_collection(coll_name)
    except Exception:
        pass

    # Delete KBVersion record
    await db.execute(
        KBVersion.__table__.delete().where(KBVersion.version == version_id)
    )
    await db.commit()

    return {"message": f"Version {version_id} deleted", "documents_deleted": count}


BACKUP_DIR = Path(os.getenv("BACKUP_DIR", str(_PROJECT_ROOT / "backups")))
BACKUP_DIR.mkdir(parents=True, exist_ok=True)


@app.post("/api/kb/backup/{version_id}")
async def backup_kb_version(
    version_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a snapshot backup of a KB version's Qdrant collection."""
    from qdrant_client import QdrantClient as _QC
    s = await _get_settings_dict(db)
    client = _QC(url=s["qdrant_url"])
    coll_name = get_collection_name(version_id)

    if not client.collection_exists(coll_name):
        raise HTTPException(status_code=404, detail=f"Collection {coll_name} not found")

    # Create snapshot on Qdrant server
    snapshot_info = client.create_snapshot(collection_name=coll_name)
    snap_name = snapshot_info.name

    # Download snapshot to local backups dir
    import urllib.request
    qdrant_url = s["qdrant_url"]
    snap_url = f"{qdrant_url}/collections/{coll_name}/snapshots/{snap_name}"
    local_path = BACKUP_DIR / f"{coll_name}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.snapshot"

    urllib.request.urlretrieve(snap_url, str(local_path))

    # Clean up server-side snapshot
    try:
        client.delete_snapshot(collection_name=coll_name, snapshot_name=snap_name)
    except Exception:
        pass

    size_mb = local_path.stat().st_size / (1024 * 1024)
    return {
        "message": f"Backup saved: {local_path.name} ({size_mb:.1f} MB)",
        "file": local_path.name,
        "size_mb": round(size_mb, 1),
    }


@app.get("/api/kb/backups")
async def list_kb_backups(
    _admin: User = Depends(require_admin),
):
    """List available KB backups."""
    backups = []
    for f in sorted(BACKUP_DIR.glob("*.snapshot"), key=lambda p: p.stat().st_mtime, reverse=True):
        backups.append({
            "name": f.name,
            "size_mb": round(f.stat().st_size / (1024 * 1024), 1),
            "created_at": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
        })
    return backups


@app.post("/api/kb/restore/{filename}")
async def restore_kb_backup(
    filename: str,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Restore a KB collection from a snapshot backup."""
    # Sanitize: basename only, must stay within BACKUP_DIR, must be a snapshot.
    safe = Path(filename).name
    if not safe.endswith(".snapshot"):
        raise HTTPException(status_code=400, detail="Invalid backup filename")
    snap_path = (BACKUP_DIR / safe).resolve()
    if not snap_path.is_relative_to(BACKUP_DIR.resolve()):
        raise HTTPException(status_code=400, detail="Invalid backup path")
    filename = safe
    if not snap_path.exists():
        raise HTTPException(status_code=404, detail=f"Backup not found: {filename}")

    # Extract version from filename (e.g., "policy_v3_20260405_080000.snapshot")
    import re as _re
    match = _re.search(r'policy_v(\d+)', filename)
    if not match:
        raise HTTPException(status_code=400, detail="Cannot determine version from filename")
    version_id = int(match.group(1))
    coll_name = get_collection_name(version_id)

    # Restore via Qdrant upload API
    from qdrant_client import QdrantClient as _QC
    s = await _get_settings_dict(db)
    qdrant_url = s["qdrant_url"]

    # Delete existing collection if it exists (will be replaced)
    client = _QC(url=qdrant_url)
    if client.collection_exists(coll_name):
        client.delete_collection(coll_name)

    # Upload snapshot to restore
    import httpx as _httpx
    transport = _httpx.HTTPTransport()
    with _httpx.Client(timeout=300.0, mounts={"http://localhost": transport, "http://127.0.0.1": transport}) as hc:
        with open(snap_path, "rb") as f:
            resp = hc.post(
                f"{qdrant_url}/collections/{coll_name}/snapshots/upload",
                files={"snapshot": (filename, f, "application/octet-stream")},
            )
            resp.raise_for_status()

    # Verify
    info = client.get_collection(coll_name)
    points = info.points_count

    # Recreate DB records if they don't exist for this version
    result = await db.execute(
        select(func.count(KBDocument.id)).where(KBDocument.version == version_id)
    )
    existing = result.scalar() or 0

    return {
        "message": f"Restored {coll_name}: {points} points",
        "version": version_id,
        "points": points,
        "db_records": existing,
    }


@app.post("/api/kb/reingest-all")
async def reingest_all_documents(
    background_tasks: BackgroundTasks,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a new KB version and re-ingest all ready documents with improved pipeline."""
    if (await _ingestion_running_state())["running"]:
        raise HTTPException(status_code=409, detail="Ingestion batch already running. Please wait for it to finish.")

    s = await _get_settings_dict(db)
    current_version = await get_current_version(db)
    new_version = await create_new_version(db, embed_model=s["embed_model"])

    # Delete any stale Qdrant collection for the new version (e.g., from a previous failed attempt)
    try:
        from ingest import get_collection_name
        from qdrant_client import QdrantClient as _QC
        qdrant_client = _QC(url=(await _get_settings_dict(db))["qdrant_url"])
        coll_name = get_collection_name(new_version)
        if qdrant_client.collection_exists(coll_name):
            qdrant_client.delete_collection(coll_name)
            print(f"Deleted stale collection {coll_name}")
    except Exception:
        pass

    # Only pick docs from the current version (not all versions)
    result = await db.execute(
        select(KBDocument).where(
            KBDocument.status == "ready",
            KBDocument.version == current_version,
        )
    )
    ready_docs = result.scalars().all()

    if not ready_docs:
        return {"message": "No ready documents to re-ingest", "count": 0}

    reingest_list = []
    for doc in ready_docs:
        if doc.file_path and os.path.exists(doc.file_path):
            new_doc = KBDocument(
                filename=doc.filename,
                version=new_version,
                status="processing",
                file_path=doc.file_path,
                is_questionnaire=bool(doc.is_questionnaire),
            )
            db.add(new_doc)
            await db.flush()
            reingest_list.append((new_doc.id, doc.file_path, doc.filename, new_version, bool(doc.is_questionnaire)))

    await db.commit()

    background_tasks.add_task(_retry_batch, reingest_list)

    return {
        "message": f"Re-ingesting {len(reingest_list)} documents into v{new_version}",
        "new_version": new_version,
        "count": len(reingest_list),
    }


@app.get("/api/kb/documents")
async def list_kb_documents(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    version: Optional[int] = None,
    status_filter: Optional[str] = Query(None, alias="status"),
    search: Optional[str] = Query(None),
    _user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Base conditions (version filter only — for counts)
    base_conditions = []
    if version is not None:
        base_conditions.append(KBDocument.version == version)
    base_where = and_(*base_conditions) if base_conditions else True

    # Full conditions (version + status + search — for listing)
    list_conditions = list(base_conditions)
    if status_filter is not None:
        list_conditions.append(KBDocument.status == status_filter)
    if search and search.strip():
        list_conditions.append(KBDocument.filename.ilike(f"%{search.strip()}%"))
    list_where = and_(*list_conditions) if list_conditions else True

    # Count totals by status (always unfiltered by status, so badges show full picture)
    for status_name in ("ready", "processing", "failed"):
        count_q = select(func.count(KBDocument.id)).where(
            and_(base_where, KBDocument.status == status_name)
        )
        count = (await db.execute(count_q)).scalar() or 0
        if status_name == "ready":
            ready_count = count
        elif status_name == "processing":
            processing_count = count
        else:
            failed_count = count

    total = ready_count + processing_count + failed_count

    # If any filter active (status or search), count filtered total for pagination
    has_filter = status_filter or (search and search.strip())
    if has_filter:
        filtered_count = await db.execute(
            select(func.count(KBDocument.id)).where(list_where)
        )
        filtered_total = filtered_count.scalar() or 0
    else:
        filtered_total = total

    # Paginated query
    offset = (page - 1) * per_page
    q = (
        select(KBDocument)
        .where(list_where)
        .order_by(desc(KBDocument.ingested_at))
        .offset(offset)
        .limit(per_page)
    )
    result = await db.execute(q)
    docs = result.scalars().all()

    return {
        "items": [
            {
                "id": d.id,
                "filename": d.filename,
                "version": d.version,
                "ingested_at": d.ingested_at.isoformat() if d.ingested_at else None,
                "chunk_count": d.chunk_count,
                "status": d.status,
                "error_message": d.error_message,
                "is_questionnaire": bool(d.is_questionnaire) if hasattr(d, "is_questionnaire") else False,
            }
            for d in docs
        ],
        "total": filtered_total,
        "ready_count": ready_count,
        "processing_count": processing_count,
        "failed_count": failed_count,
        "page": page,
        "per_page": per_page,
    }


@app.delete("/api/kb/clear-all")
async def clear_all_kb(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Delete ALL KB documents, uploaded files, and Qdrant collections."""
    from ingest import get_collection_name

    # 1. Get all documents and their versions
    result = await db.execute(select(KBDocument))
    docs = result.scalars().all()
    versions_to_delete = set()

    # 2. Delete uploaded files and DB records
    for doc in docs:
        if doc.file_path and os.path.exists(doc.file_path):
            try:
                os.remove(doc.file_path)
            except Exception:
                pass
        versions_to_delete.add(doc.version)
        await db.delete(doc)

    await db.commit()

    # 3. Delete Qdrant collections for all versions
    try:
        from qdrant_client import QdrantClient
        s = await _get_settings_dict(db)
        client = QdrantClient(url=s["qdrant_url"])
        for version in versions_to_delete:
            collection_name = get_collection_name(version)
            if client.collection_exists(collection_name):
                client.delete_collection(collection_name)
    except Exception as e:
        print(f"Warning: Could not clear Qdrant collections: {e}")

    # 4. Clean up extracted ZIP directories
    import shutil
    for item in UPLOAD_DIR.iterdir():
        try:
            if item.is_dir() and item.name.startswith("zip_"):
                shutil.rmtree(item)
            elif item.is_file():
                item.unlink()
        except Exception:
            pass

    return {
        "message": f"Cleared {len(docs)} documents and {len(versions_to_delete)} Qdrant collections",
        "documents_deleted": len(docs),
        "collections_deleted": len(versions_to_delete),
    }


@app.delete("/api/kb/documents/{doc_id}")
async def delete_kb_document(
    doc_id: int,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(KBDocument).where(KBDocument.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.file_path and os.path.exists(doc.file_path):
        os.remove(doc.file_path)
    await db.delete(doc)
    await db.commit()
    return {"message": "Document deleted"}


# ---------------------------------------------------------------------------
# QUESTIONNAIRE PROCESSING
# ---------------------------------------------------------------------------

@app.post("/api/questionnaire/upload")
async def upload_questionnaire(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    allowed = {".pdf", ".docx", ".xlsx", ".txt", ".json", ".html", ".htm", ".csv", ".md"}
    ext = Path(file.filename).suffix.lower()
    if ext not in allowed:
        raise HTTPException(status_code=400, detail=f"Unsupported format: {ext}")

    file_path = _save_upload(file, UPLOAD_DIR)
    file_type = ext.lstrip(".")

    # Extract questions to get count
    questions = extract_questions(str(file_path), file_type)

    job_id = await create_job(db, current_user.id, file.filename)

    # Update total questions
    await update_job_status(db, job_id, "queued")
    result = await db.execute(select(ProcessingJob).where(ProcessingJob.id == job_id))
    job = result.scalar_one()
    job.total_questions = len(questions)
    await db.commit()

    background_tasks.add_task(
        _process_questionnaire_background,
        job_id, str(file_path), file_type, questions, current_user.id,
    )

    return {
        "job_id": job_id,
        "filename": file.filename,
        "format": file_type,
        "question_count": len(questions),
        "status": "queued",
    }


async def _process_questionnaire_background(
    job_id: int, file_path: str, file_type: str,
    questions: list, user_id: int,
):
    async with async_session() as db:
        try:
            await update_job_status(db, job_id, "processing")
            s = await _get_settings_dict(db)
            version = await get_current_version(db)
            qa_pairs = []

            # Use LLM-based extraction for better question detection
            from extractor import extract_questions_smart
            try:
                smart_questions = await extract_questions_smart(file_path, file_type, settings_dict=s)
                if smart_questions and len(smart_questions) > 0:
                    questions = smart_questions
                    # Update total question count
                    result_job = await db.execute(
                        select(ProcessingJob).where(ProcessingJob.id == job_id)
                    )
                    job_obj = result_job.scalar_one()
                    job_obj.total_questions = len(questions)
                    await db.commit()
            except Exception as e:
                print(f"Smart extraction failed, using heuristic results: {e}")

            # Import answer post-processor
            from llm_skills import clean_answer_with_llm

            for i, q in enumerate(questions):
                # Check if job was cancelled (DB-backed; survives restart / works across workers)
                cancel_row = await db.execute(
                    select(ProcessingJob.cancel_requested).where(ProcessingJob.id == job_id)
                )
                if cancel_row.scalar_one_or_none():
                    await update_job_status(db, job_id, "cancelled", error_message="Stopped by user")
                    return

                question_text = q["question_text"]
                section_context = q.get("section_context", "")

                # Detect language and translate if needed
                lang = detect_language(question_text)
                was_translated = lang != "en"
                search_text = question_text

                if was_translated:
                    search_text = await translate_to_english(
                        question_text, lang, s["ollama_url"], s["llm_model"],
                        provider=s.get("llm_provider", "claude_code"),
                    )

                # Prepend section context to search for better KB matching
                if section_context:
                    search_text = f"[{section_context}] {search_text}"

                # Query knowledge base
                result = await query_knowledge_base(search_text, version, s)

                answer = result["answer"]

                # Post-process answer with LLM (clean up boilerplate)
                if answer and result["confidence_tier"] != "no_answer":
                    try:
                        cleaned = await clean_answer_with_llm(answer, question_text, settings_dict=s)
                        if cleaned and len(cleaned) > 10:
                            answer = cleaned
                    except Exception:
                        pass  # Keep original answer

                # Translate answer back if needed
                if was_translated and answer and answer != "NO_ANSWER_FOUND":
                    answer = await translate_from_english(
                        answer, lang, s["ollama_url"], s["llm_model"],
                        provider=s.get("llm_provider", "claude_code"),
                    )

                qa_pair = {
                    "question_text": question_text,
                    "answer_text": answer,
                    "confidence_score": result["confidence_score"],
                    "confidence_tier": result["confidence_tier"],
                    "location_info": q["location_info"],
                    "sources": result["sources"],
                }
                qa_pairs.append(qa_pair)

                # Log audit + advance progress atomically (single commit per question).
                await log_answer(
                    db,
                    question_text=question_text,
                    answer_text=answer,
                    confidence_score=result["confidence_score"],
                    confidence_tier=result["confidence_tier"],
                    kb_version_used=version,
                    llm_model_used="claude-code" if s.get("llm_provider") == "claude_code" else s["llm_model"],
                    source_citations=result["sources"],
                    was_translated=was_translated,
                    original_language=lang,
                    processing_job_id=job_id,
                    user_id=user_id,
                    commit=False,
                )

                await update_job_status(
                    db, job_id, "processing", processed_questions=i + 1, commit=False
                )
                await db.commit()

            # Fill document
            output_path = await fill_document(file_path, file_type, qa_pairs, version)

            await update_job_status(
                db, job_id, "done", output_file_path=str(output_path),
                processed_questions=len(questions),
            )

        except Exception as e:
            await update_job_status(db, job_id, "failed", error_message=str(e))
            print(f"Processing failed for job {job_id}: {e}")


@app.get("/api/questionnaire/jobs")
async def list_jobs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    jobs = await get_user_jobs(db, current_user.id)
    return [
        {
            "id": j.id,
            "filename": j.filename,
            "status": j.status,
            "total_questions": j.total_questions,
            "processed_questions": j.processed_questions,
            "created_at": j.created_at.isoformat() if j.created_at else None,
            "completed_at": j.completed_at.isoformat() if j.completed_at else None,
            "error_message": j.error_message,
        }
        for j in jobs
    ]


@app.get("/api/questionnaire/jobs/{job_id}")
async def get_job_status(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")
    return {
        "id": job.id,
        "filename": job.filename,
        "status": job.status,
        "total_questions": job.total_questions,
        "processed_questions": job.processed_questions,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "error_message": job.error_message,
    }


def _job_payload(job: ProcessingJob) -> dict:
    return {
        "id": job.id,
        "filename": job.filename,
        "status": job.status,
        "total_questions": job.total_questions,
        "processed_questions": job.processed_questions,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        "error_message": job.error_message,
    }


@app.get("/api/questionnaire/jobs/{job_id}/stream")
async def stream_job_status(
    job_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """Server-Sent Events stream of a job's status until it reaches a terminal state."""
    # Authorize once up front (fresh session).
    async with async_session() as db:
        job = await get_job(db, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found")
        if job.user_id != current_user.id and current_user.role != "admin":
            raise HTTPException(status_code=403, detail="Access denied")

    terminal = {"done", "failed", "cancelled"}

    async def event_gen():
        last = None
        # Safety cap so a stuck job can't hold the connection forever (~30 min).
        for _ in range(1800):
            if await request.is_disconnected():
                break
            async with async_session() as db:
                job = await get_job(db, job_id)
            if not job:
                yield f"event: error\ndata: {json.dumps({'detail': 'Job not found'})}\n\n"
                return
            payload = _job_payload(job)
            snapshot = (payload["status"], payload["processed_questions"], payload["total_questions"])
            if snapshot != last:
                last = snapshot
                yield f"data: {json.dumps(payload)}\n\n"
            if payload["status"] in terminal:
                return
            await asyncio.sleep(1)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/questionnaire/jobs/{job_id}/cancel")
async def cancel_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Cancel a running questionnaire processing job."""
    job = await get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")
    if job.status not in ("queued", "processing"):
        raise HTTPException(status_code=400, detail=f"Job is already {job.status}")

    job.cancel_requested = True
    await db.commit()
    return {"message": "Cancel requested", "job_id": job_id}


@app.get("/api/questionnaire/jobs/{job_id}/download")
async def download_filled_document(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")
    if job.status != "done" or not job.output_file_path:
        raise HTTPException(status_code=400, detail="Document not ready")
    if not os.path.exists(job.output_file_path):
        raise HTTPException(status_code=404, detail="Output file not found")
    # Use the actual output file's extension (e.g., PDF input may produce DOCX output)
    output_ext = Path(job.output_file_path).suffix
    original_stem = Path(job.filename).stem
    download_name = f"filled_{original_stem}{output_ext}"
    return FileResponse(
        job.output_file_path,
        filename=download_name,
        media_type="application/octet-stream",
    )


@app.get("/api/questionnaire/jobs/{job_id}/results")
async def get_job_results(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return Q&A pairs from audit log for a given job."""
    job = await get_job(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.user_id != current_user.id and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Access denied")

    result = await db.execute(
        select(AuditLog)
        .where(AuditLog.processing_job_id == job_id)
        .order_by(AuditLog.id)
    )
    logs = result.scalars().all()
    return [
        {
            "question_text": l.question_text,
            "answer_text": l.answer_text,
            "confidence_score": l.confidence_score,
            "confidence_tier": l.confidence_tier,
            "source_citations": l.source_citations,
            "was_translated": l.was_translated,
            "original_language": l.original_language,
        }
        for l in logs
    ]


# ---------------------------------------------------------------------------
# AUDIT LOG ROUTES
# ---------------------------------------------------------------------------

@app.get("/api/audit")
async def list_audit_logs(
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    confidence_tier: Optional[str] = None,
    flagged_only: bool = False,
    kb_version: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    filters = {
        "page": page,
        "per_page": per_page,
        "confidence_tier": confidence_tier,
        "flagged_only": flagged_only,
        "kb_version": kb_version,
        "date_from": date_from,
        "date_to": date_to,
    }
    # Non-admin users only see their own logs
    if current_user.role != "admin":
        filters["user_id"] = current_user.id

    logs, total = await get_audit_logs(db, filters)
    return {
        "items": [
            {
                "id": l.id,
                "question_text": l.question_text,
                "answer_text": l.answer_text,
                "confidence_score": l.confidence_score,
                "confidence_tier": l.confidence_tier,
                "kb_version_used": l.kb_version_used,
                "llm_model_used": l.llm_model_used,
                "source_citations": l.source_citations,
                "was_translated": l.was_translated,
                "original_language": l.original_language,
                "processing_job_id": l.processing_job_id,
                "timestamp": l.timestamp.isoformat() if l.timestamp else None,
            }
            for l in logs
        ],
        "total": total,
        "page": page,
        "per_page": per_page,
    }


@app.get("/api/audit/export/csv")
async def export_audit_logs_csv(
    confidence_tier: Optional[str] = None,
    flagged_only: bool = False,
    kb_version: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    filters = {
        "confidence_tier": confidence_tier,
        "flagged_only": flagged_only,
        "kb_version": kb_version,
        "date_from": date_from,
        "date_to": date_to,
    }
    if current_user.role != "admin":
        filters["user_id"] = current_user.id

    csv_content = await export_audit_csv(db, filters)
    return StreamingResponse(
        io.StringIO(csv_content),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=audit_log.csv"},
    )


@app.get("/api/audit/{log_id}")
async def get_audit_log_detail(
    log_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(AuditLog).where(AuditLog.id == log_id))
    log = result.scalar_one_or_none()
    if not log:
        raise HTTPException(status_code=404, detail="Log not found")
    if current_user.role != "admin" and log.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")
    return {
        "id": log.id,
        "question_text": log.question_text,
        "answer_text": log.answer_text,
        "confidence_score": log.confidence_score,
        "confidence_tier": log.confidence_tier,
        "kb_version_used": log.kb_version_used,
        "llm_model_used": log.llm_model_used,
        "source_citations": log.source_citations,
        "was_translated": log.was_translated,
        "original_language": log.original_language,
        "processing_job_id": log.processing_job_id,
        "timestamp": log.timestamp.isoformat() if log.timestamp else None,
    }


# ---------------------------------------------------------------------------
# DASHBOARD STATS
# ---------------------------------------------------------------------------

@app.get("/api/dashboard/stats")
async def dashboard_stats(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Active KB version info
    version = await get_current_version(db)
    version_result = await db.execute(
        select(KBVersion).where(KBVersion.is_active == True).limit(1)
    )
    active_kv = version_result.scalar_one_or_none()

    # KB docs for active version only
    kb_count_result = await db.execute(
        select(func.count(KBDocument.id)).where(
            KBDocument.status == "ready", KBDocument.version == version
        )
    )
    total_kb_docs = kb_count_result.scalar() or 0

    # KB status breakdown for active version
    kb_statuses = {}
    for s in ("ready", "processing", "failed"):
        r = await db.execute(
            select(func.count(KBDocument.id)).where(
                KBDocument.status == s, KBDocument.version == version
            )
        )
        kb_statuses[s] = r.scalar() or 0

    # Total questionnaires processed
    jobs_result = await db.execute(
        select(func.count(ProcessingJob.id)).where(ProcessingJob.status == "done")
    )
    total_questionnaires = jobs_result.scalar() or 0

    # Total questions answered (all time)
    total_answers_result = await db.execute(select(func.count(AuditLog.id)))
    total_answers = total_answers_result.scalar() or 0

    # Confidence distribution (all time)
    confidence_dist = {}
    for tier in ("auto_fill", "needs_review", "no_answer"):
        r = await db.execute(
            select(func.count(AuditLog.id)).where(AuditLog.confidence_tier == tier)
        )
        confidence_dist[tier] = r.scalar() or 0

    # Today's stats
    today = datetime.utcnow().date()
    today_start = datetime(today.year, today.month, today.day)

    auto_filled_result = await db.execute(
        select(func.count(AuditLog.id)).where(
            and_(AuditLog.timestamp >= today_start, AuditLog.confidence_tier == "auto_fill")
        )
    )
    auto_filled_today = auto_filled_result.scalar() or 0

    flagged_result = await db.execute(
        select(func.count(AuditLog.id)).where(
            and_(AuditLog.timestamp >= today_start, AuditLog.confidence_tier.in_(["needs_review", "no_answer"]))
        )
    )
    flagged_today = flagged_result.scalar() or 0

    # Total versions
    versions_result = await db.execute(select(func.count(KBVersion.id)))
    total_versions = versions_result.scalar() or 0

    return {
        "total_kb_docs": total_kb_docs,
        "total_questionnaires": total_questionnaires,
        "auto_filled_today": auto_filled_today,
        "flagged_today": flagged_today,
        "total_answers": total_answers,
        "kb_version": version,
        "kb_version_name": active_kv.name if active_kv else f"Version {version}",
        "kb_embed_model": active_kv.embed_model if active_kv else "unknown",
        "kb_ready": kb_statuses.get("ready", 0),
        "kb_processing": kb_statuses.get("processing", 0),
        "kb_failed": kb_statuses.get("failed", 0),
        "total_versions": total_versions,
        "confidence_auto_fill": confidence_dist.get("auto_fill", 0),
        "confidence_needs_review": confidence_dist.get("needs_review", 0),
        "confidence_no_answer": confidence_dist.get("no_answer", 0),
    }


@app.get("/api/dashboard/recent-audit")
async def dashboard_recent_audit(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(AuditLog).order_by(desc(AuditLog.timestamp)).limit(10)
    if current_user.role != "admin":
        q = q.where(AuditLog.user_id == current_user.id)
    result = await db.execute(q)
    logs = result.scalars().all()
    return [
        {
            "id": l.id,
            "question_text": l.question_text[:100],
            "answer_text": (l.answer_text or "")[:100],
            "confidence_score": l.confidence_score,
            "confidence_tier": l.confidence_tier,
            "timestamp": l.timestamp.isoformat() if l.timestamp else None,
        }
        for l in logs
    ]


@app.get("/api/dashboard/active-jobs")
async def dashboard_active_jobs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(ProcessingJob).where(
        ProcessingJob.status.in_(["queued", "processing"])
    ).order_by(desc(ProcessingJob.created_at))
    if current_user.role != "admin":
        q = q.where(ProcessingJob.user_id == current_user.id)
    result = await db.execute(q)
    jobs = result.scalars().all()
    return [
        {
            "id": j.id,
            "filename": j.filename,
            "status": j.status,
            "total_questions": j.total_questions,
            "processed_questions": j.processed_questions,
            "created_at": j.created_at.isoformat() if j.created_at else None,
        }
        for j in jobs
    ]


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# URL VALIDATION
# ---------------------------------------------------------------------------

# Track URL validation progress
_url_validation_running = False
_url_validation_progress = {"checked": 0, "total": 0, "down_urls": []}


@app.post("/api/kb/validate-urls")
async def validate_kb_urls(
    version: int = Query(...),
    background_tasks: BackgroundTasks = BackgroundTasks(),
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Extract all URLs from a KB version and check if they're accessible."""
    global _url_validation_running
    if _url_validation_running:
        raise HTTPException(status_code=409, detail="URL validation already running")

    s = await _get_settings_dict(db)
    coll_name = get_collection_name(version)

    from qdrant_client import QdrantClient as _QC
    client = _QC(url=s["qdrant_url"])
    if not client.collection_exists(coll_name):
        raise HTTPException(status_code=404, detail=f"Collection {coll_name} not found")

    # Extract all unique URLs from the collection
    import re as _re
    url_to_sources = {}  # url -> set of source files
    offset = None
    while True:
        results, next_offset = client.scroll(
            collection_name=coll_name, limit=100, offset=offset
        )
        if not results:
            break
        for point in results:
            text = point.payload.get("text", "")
            source = point.payload.get("source_file", "unknown")
            urls = _re.findall(r'https?://[^\s<>"\')\]\},]+', text)
            for url in urls:
                # Clean trailing punctuation
                url = url.rstrip(".,;:")
                if url not in url_to_sources:
                    url_to_sources[url] = set()
                url_to_sources[url].add(source)
        offset = next_offset
        if offset is None:
            break

    if not url_to_sources:
        return {"message": "No URLs found in this KB version", "total": 0, "down": []}

    _url_validation_running = True
    _url_validation_progress["checked"] = 0
    _url_validation_progress["total"] = len(url_to_sources)
    _url_validation_progress["down_urls"] = []

    background_tasks.add_task(_check_urls_batch, url_to_sources)

    return {
        "message": f"Checking {len(url_to_sources)} unique URLs",
        "total": len(url_to_sources),
    }


@app.get("/api/kb/url-validation-status")
async def get_url_validation_status(
    _user: User = Depends(get_current_user),
):
    """Get URL validation progress and results."""
    return {
        "running": _url_validation_running,
        "checked": _url_validation_progress["checked"],
        "total": _url_validation_progress["total"],
        "down_urls": _url_validation_progress["down_urls"],
    }


async def _check_urls_batch(url_to_sources: dict):
    """Check all URLs in parallel with concurrency limit."""
    import asyncio
    global _url_validation_running, _url_validation_progress

    semaphore = asyncio.Semaphore(5)  # 5 concurrent to avoid rate limiting

    async def _check_one(url: str, sources: set):
        async with semaphore:
            try:
                import httpx as _hx
                transport = _hx.AsyncHTTPTransport()
                headers = {
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                }
                async with _hx.AsyncClient(
                    timeout=15.0,
                    follow_redirects=True,
                    headers=headers,
                    mounts={"http://localhost": transport, "http://127.0.0.1": transport},
                ) as client:
                    # Try HEAD first, fall back to GET if HEAD fails
                    resp = await client.head(url)
                    if resp.status_code >= 400:
                        resp = await client.get(url)
                    # If still failing, retry once after a small delay (rate limiting)
                    if resp.status_code >= 400:
                        await asyncio.sleep(1)
                        resp = await client.get(url)
                    if resp.status_code >= 400:
                        _url_validation_progress["down_urls"].append({
                            "url": url,
                            "status": resp.status_code,
                            "sources": sorted(sources),
                        })
            except Exception as e:
                _url_validation_progress["down_urls"].append({
                    "url": url,
                    "status": str(e)[:80],
                    "sources": sorted(sources),
                })
            finally:
                _url_validation_progress["checked"] += 1

    try:
        tasks = [_check_one(url, sources) for url, sources in url_to_sources.items()]
        await asyncio.gather(*tasks)
    finally:
        _url_validation_running = False


# CHAT ROUTE
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    role: str  # "user" or "assistant"
    text: str


class ChatRequest(BaseModel):
    question: str
    history: List[ChatMessage] = []


@app.post("/api/chat")
async def chat_query(
    req: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Ask a question against the knowledge base and get an answer."""
    question = req.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    s = await _get_settings_dict(db)
    version = await get_current_version(db)

    # Build contextual search query using conversation history
    # If there's history, ask the LLM to make the question self-contained
    search_text = question
    if req.history:
        recent = req.history[-6:]  # Last 3 exchanges max
        history_text = "\n".join(f"{m.role}: {m.text[:200]}" for m in recent)
        try:
            from llm_skills import _call_llm_generic
            rewrite_prompt = (
                "Given this conversation history and the latest question, rewrite the question "
                "to be fully self-contained (include all necessary context from the conversation). "
                "Return ONLY the rewritten question, nothing else.\n\n"
                f"Conversation:\n{history_text}\n\n"
                f"Latest question: {question}\n\n"
                "Self-contained question:"
            )
            rewritten = await _call_llm_generic(rewrite_prompt, s)
            if rewritten and len(rewritten) > 5 and "NO_ANSWER_FOUND" not in rewritten:
                search_text = rewritten.strip()
                print(f"Chat rewrite: '{question}' → '{search_text}'")
        except Exception:
            pass  # Use original question

    result = await query_knowledge_base(search_text, version, s)

    # Optionally clean up the answer
    answer = result["answer"]
    if answer and result["confidence_tier"] != "no_answer":
        try:
            from llm_skills import clean_answer_with_llm
            cleaned = await clean_answer_with_llm(answer, question, settings_dict=s)
            if cleaned and len(cleaned) > 10:
                answer = cleaned
        except Exception:
            pass

    # Strip markdown formatting (bold, italic, headings) from chat responses
    if answer:
        from filler import _strip_markdown
        answer = _strip_markdown(answer)

    return {
        "answer": answer or "No confident answer found in the knowledge base.",
        "confidence_score": result["confidence_score"],
        "confidence_tier": result["confidence_tier"],
        "sources": result["sources"],
        "kb_version": version,
    }


# ---------------------------------------------------------------------------
# SETTINGS ROUTES (Admin Only)
# ---------------------------------------------------------------------------

@app.get("/api/settings")
async def get_settings(
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    return await _get_settings_dict(db)


@app.put("/api/settings")
async def update_settings(
    req: SettingsUpdateRequest,
    _admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    updates = req.dict(exclude_none=True)
    for key, value in updates.items():
        result = await db.execute(
            select(SettingsModel).where(SettingsModel.key == key)
        )
        existing = result.scalar_one_or_none()
        if existing:
            existing.value = str(value)
            existing.updated_at = datetime.utcnow()
        else:
            db.add(SettingsModel(key=key, value=str(value)))
    await db.commit()
    return {"message": "Settings updated"}


@app.post("/api/settings/test-connection")
async def test_connection(
    req: TestConnectionRequest,
    _admin: User = Depends(require_admin),
):
    import httpx

    try:
        if req.model_type == "claude_code":
            # Test Claude Code CLI
            import asyncio as _asyncio
            try:
                proc = await _asyncio.create_subprocess_exec(
                    "claude", "-p", "Say hello in one word", "--output-format", "text",
                    stdout=_asyncio.subprocess.PIPE,
                    stderr=_asyncio.subprocess.PIPE,
                )
                stdout, stderr = await _asyncio.wait_for(proc.communicate(), timeout=30)
                if proc.returncode == 0:
                    response = stdout.decode().strip()[:100]
                    return {"status": "success", "message": f"Claude Code connected: \"{response}\""}
                return {"status": "error", "message": f"Claude Code exited with code {proc.returncode}: {stderr.decode()[:200]}"}
            except FileNotFoundError:
                return {"status": "error", "message": "Claude Code CLI not found. Is 'claude' in your PATH?"}
            except _asyncio.TimeoutError:
                return {"status": "error", "message": "Claude Code CLI timed out (30s)"}
            except Exception as e:
                return {"status": "error", "message": f"Claude Code error: {str(e)}"}

        elif req.model_type == "embedding":
            _t = httpx.AsyncHTTPTransport()
            async with httpx.AsyncClient(timeout=10.0, mounts={"http://localhost": _t, "http://127.0.0.1": _t}) as client:
                resp = await client.post(
                    f"{req.ollama_url}/api/embeddings",
                    json={"model": req.model, "prompt": "test"},
                )
                if resp.status_code == 200:
                    return {"status": "success", "message": f"Embedding model '{req.model}' is available"}
                return {"status": "error", "message": f"Model responded with status {resp.status_code}"}
        else:
            _t2 = httpx.AsyncHTTPTransport()
            async with httpx.AsyncClient(timeout=30.0, mounts={"http://localhost": _t2, "http://127.0.0.1": _t2}) as client:
                resp = await client.post(
                    f"{req.ollama_url}/api/generate",
                    json={"model": req.model, "prompt": "Say hello", "stream": False},
                )
                if resp.status_code == 200:
                    return {"status": "success", "message": f"LLM model '{req.model}' is available"}
                return {"status": "error", "message": f"Model responded with status {resp.status_code}"}
    except httpx.ConnectError:
        return {"status": "error", "message": f"Cannot connect to {req.ollama_url}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# ---------------------------------------------------------------------------
# HEALTH CHECK
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}
