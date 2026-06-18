"""
Compliance Pilot — SQLAlchemy async models.
"""

from datetime import datetime

from sqlalchemy import Column, Integer, String, Float, Boolean, Text, DateTime, ForeignKey
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

from config import settings

Base = declarative_base()

engine = create_async_engine(settings.DATABASE_URL, echo=False)
async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def init_db():
    """Create all tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # Seed default admin if not exists
    async with async_session() as session:
        from sqlalchemy import select, func
        from auth import hash_password
        result = await session.execute(select(User).where(User.username == "admin"))
        if not result.scalar_one_or_none():
            admin = User(
                username="admin",
                hashed_password=hash_password("admin123"),
                role="admin",
                must_change_password=True,
            )
            session.add(admin)
            await session.commit()
            print("=" * 60)
            print("  DEFAULT ADMIN CREATED")
            print("  Username: admin")
            print("  Password: admin123")
            print("  ** Change this password on first login **")
            print("=" * 60)

    # Migrate: add is_questionnaire column if missing
    async with engine.begin() as conn:
        def _add_is_questionnaire(connection):
            raw = connection.connection.dbapi_connection
            cursor = raw.cursor()
            cursor.execute("PRAGMA table_info(kb_documents)")
            columns = [row[1] for row in cursor.fetchall()]
            if "is_questionnaire" not in columns:
                cursor.execute("ALTER TABLE kb_documents ADD COLUMN is_questionnaire BOOLEAN DEFAULT 0")
                print("Migrated: added is_questionnaire column to kb_documents")
        await conn.run_sync(_add_is_questionnaire)

    # Migrate: add cancel_requested column to processing_jobs if missing
    async with engine.begin() as conn:
        def _add_cancel_requested(connection):
            raw = connection.connection.dbapi_connection
            cursor = raw.cursor()
            cursor.execute("PRAGMA table_info(processing_jobs)")
            columns = [row[1] for row in cursor.fetchall()]
            if "cancel_requested" not in columns:
                cursor.execute("ALTER TABLE processing_jobs ADD COLUMN cancel_requested BOOLEAN DEFAULT 0")
                print("Migrated: added cancel_requested column to processing_jobs")
        await conn.run_sync(_add_cancel_requested)

    # Migrate: populate kb_versions from existing KBDocument data
    async with async_session() as session:
        from sqlalchemy import select, func, distinct
        result = await session.execute(select(func.count(KBVersion.id)))
        if result.scalar() == 0:
            # Get existing versions from documents
            ver_result = await session.execute(
                select(
                    KBDocument.version,
                    func.count(KBDocument.id).label("cnt"),
                ).where(KBDocument.status == "ready").group_by(KBDocument.version)
            )
            versions = ver_result.all()

            # Get current active version from settings
            settings_result = await session.execute(
                select(Settings).where(Settings.key == "kb_version")
            )
            active_setting = settings_result.scalar_one_or_none()
            active_ver = int(active_setting.value) if active_setting else 0

            for ver, doc_count in versions:
                kv = KBVersion(
                    version=ver,
                    name=f"Version {ver}",
                    embed_model="unknown",
                    doc_count=doc_count,
                    is_active=(ver == active_ver),
                )
                session.add(kv)

            if versions:
                await session.commit()
                print(f"Migrated {len(versions)} existing KB versions")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False, default="user")  # "admin" or "user"
    must_change_password = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    question_text = Column(Text, nullable=False)
    answer_text = Column(Text)
    confidence_score = Column(Float)
    confidence_tier = Column(String(20))  # "auto_fill", "needs_review", "no_answer"
    kb_version_used = Column(Integer)
    llm_model_used = Column(String(100))
    source_citations = Column(Text)  # JSON string
    was_translated = Column(Boolean, default=False)
    original_language = Column(String(10))
    processing_job_id = Column(Integer, ForeignKey("processing_jobs.id"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)


class KBDocument(Base):
    __tablename__ = "kb_documents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    filename = Column(String(255), nullable=False)
    version = Column(Integer, nullable=False, default=1)
    chunk_count = Column(Integer, default=0)
    status = Column(String(20), default="processing")  # "processing", "ready", "failed"
    error_message = Column(Text, nullable=True)
    file_path = Column(String(500))
    is_questionnaire = Column(Boolean, default=False)
    ingested_at = Column(DateTime, default=datetime.utcnow)


class ProcessingJob(Base):
    __tablename__ = "processing_jobs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    filename = Column(String(255))
    status = Column(String(20), default="queued")  # "queued", "processing", "done", "failed"
    total_questions = Column(Integer, default=0)
    processed_questions = Column(Integer, default=0)
    output_file_path = Column(String(500))
    error_message = Column(Text)
    cancel_requested = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)


class KBVersion(Base):
    __tablename__ = "kb_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    version = Column(Integer, unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    embed_model = Column(String(100))
    doc_count = Column(Integer, default=0)
    is_active = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Settings(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(100), unique=True, nullable=False)
    value = Column(Text)
    updated_at = Column(DateTime, default=datetime.utcnow)


class SystemState(Base):
    """Key/value store for cross-restart, cross-worker runtime state
    (e.g. the batch-ingestion lock + progress). Values are JSON strings."""

    __tablename__ = "system_state"

    key = Column(String(100), primary_key=True)
    value = Column(Text)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
