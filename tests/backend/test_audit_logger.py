"""
Tests for audit_logger.py — audit log creation, querying, filtering, CSV export.
"""

import csv
import io
import json

import pytest
from sqlalchemy import select

from models import AuditLog
from audit_logger import log_answer, get_audit_logs, export_audit_csv


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _insert_log(db, **overrides):
    """Insert an audit log with defaults, return the ORM object."""
    defaults = {
        "question_text": "What is your data retention policy?",
        "answer_text": "Data must be retained for 7 years.",
        "confidence_score": 0.88,
        "confidence_tier": "auto_fill",
        "kb_version_used": 1,
        "llm_model_used": "llama3.2",
        "source_citations": [{"source_file": "policy.pdf", "page_number": 3}],
        "was_translated": False,
        "original_language": "en",
        "processing_job_id": None,
        "user_id": None,
    }
    defaults.update(overrides)
    return await log_answer(db, **defaults)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestLogAnswerCreatesRow:
    """Test that log_answer creates a row in the database."""

    @pytest.mark.asyncio
    async def test_log_answer_creates_row(self, db_session):
        log = await _insert_log(db_session)

        # Query back from DB
        result = await db_session.execute(select(AuditLog).where(AuditLog.id == log.id))
        row = result.scalar_one()

        assert row.question_text == "What is your data retention policy?"
        assert row.answer_text == "Data must be retained for 7 years."
        assert row.confidence_score == 0.88
        assert row.confidence_tier == "auto_fill"
        assert row.kb_version_used == 1
        assert row.llm_model_used == "llama3.2"
        assert row.timestamp is not None


class TestAllFieldsPopulated:
    """Test that all required fields are populated after logging."""

    @pytest.mark.asyncio
    async def test_all_fields_populated(self, db_session):
        log = await _insert_log(db_session, user_id=1, processing_job_id=10)

        result = await db_session.execute(select(AuditLog).where(AuditLog.id == log.id))
        row = result.scalar_one()

        assert row.question_text is not None
        assert row.answer_text is not None
        assert row.confidence_score is not None
        assert row.confidence_tier is not None
        assert row.kb_version_used is not None
        assert row.llm_model_used is not None
        assert row.source_citations is not None
        assert row.was_translated is not None
        assert row.original_language is not None
        assert row.timestamp is not None


class TestExportCSV:
    """Test CSV export contains headers and data rows."""

    @pytest.mark.asyncio
    async def test_export_csv(self, db_session):
        await _insert_log(db_session, question_text="Q1")
        await _insert_log(db_session, question_text="Q2")

        csv_content = await export_audit_csv(db_session, {})

        reader = csv.reader(io.StringIO(csv_content))
        rows = list(reader)

        # Header row
        assert rows[0][0] == "Timestamp"
        assert "Question" in rows[0]
        assert "Answer" in rows[0]
        assert "Confidence Score" in rows[0]
        assert "Confidence Tier" in rows[0]

        # Data rows
        assert len(rows) >= 3  # header + 2 data rows


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestFlaggedAnswersMarked:
    """Test that no_answer logs can be queried via flagged filter."""

    @pytest.mark.asyncio
    async def test_flagged_answers_marked(self, db_session):
        await _insert_log(db_session, confidence_tier="auto_fill")
        await _insert_log(db_session, confidence_tier="no_answer")
        await _insert_log(db_session, confidence_tier="no_answer")

        logs, total = await get_audit_logs(db_session, {"flagged_only": True, "page": 1, "per_page": 20})

        assert total == 2
        assert all(log.confidence_tier == "no_answer" for log in logs)


class TestGetAuditLogsPagination:
    """Test pagination returns correct page."""

    @pytest.mark.asyncio
    async def test_get_audit_logs_pagination(self, db_session):
        # Insert 30 logs
        for i in range(30):
            await _insert_log(db_session, question_text=f"Question {i}")

        # Page 1, 10 per page
        logs_p1, total = await get_audit_logs(db_session, {"page": 1, "per_page": 10})
        assert total == 30
        assert len(logs_p1) == 10

        # Page 2
        logs_p2, total = await get_audit_logs(db_session, {"page": 2, "per_page": 10})
        assert total == 30
        assert len(logs_p2) == 10

        # Page 3
        logs_p3, total = await get_audit_logs(db_session, {"page": 3, "per_page": 10})
        assert total == 30
        assert len(logs_p3) == 10

        # Page 4 should be empty
        logs_p4, total = await get_audit_logs(db_session, {"page": 4, "per_page": 10})
        assert total == 30
        assert len(logs_p4) == 0

        # Ensure no overlap between pages
        ids_p1 = {l.id for l in logs_p1}
        ids_p2 = {l.id for l in logs_p2}
        ids_p3 = {l.id for l in logs_p3}
        assert ids_p1.isdisjoint(ids_p2)
        assert ids_p2.isdisjoint(ids_p3)


class TestFilterByConfidenceTier:
    """Test filtering by confidence tier."""

    @pytest.mark.asyncio
    async def test_filter_by_confidence_tier(self, db_session):
        await _insert_log(db_session, confidence_tier="auto_fill")
        await _insert_log(db_session, confidence_tier="needs_review")
        await _insert_log(db_session, confidence_tier="no_answer")
        await _insert_log(db_session, confidence_tier="auto_fill")

        # Filter auto_fill
        logs, total = await get_audit_logs(db_session, {
            "confidence_tier": "auto_fill", "page": 1, "per_page": 20
        })
        assert total == 2
        assert all(l.confidence_tier == "auto_fill" for l in logs)

        # Filter needs_review
        logs, total = await get_audit_logs(db_session, {
            "confidence_tier": "needs_review", "page": 1, "per_page": 20
        })
        assert total == 1
        assert logs[0].confidence_tier == "needs_review"

        # Filter no_answer
        logs, total = await get_audit_logs(db_session, {
            "confidence_tier": "no_answer", "page": 1, "per_page": 20
        })
        assert total == 1
        assert logs[0].confidence_tier == "no_answer"


# ---------------------------------------------------------------------------
# Failure / robustness
# ---------------------------------------------------------------------------


class TestLogSourceCitationsSerialization:
    """Test that source_citations are properly serialized as JSON."""

    @pytest.mark.asyncio
    async def test_source_citations_json(self, db_session):
        citations = [
            {"source_file": "a.pdf", "page_number": 1},
            {"source_file": "b.pdf", "page_number": 5},
        ]
        log = await _insert_log(db_session, source_citations=citations)

        result = await db_session.execute(select(AuditLog).where(AuditLog.id == log.id))
        row = result.scalar_one()
        parsed = json.loads(row.source_citations)
        assert len(parsed) == 2
        assert parsed[0]["source_file"] == "a.pdf"


class TestLogWithNullOptionalFields:
    """Test logging with null optional fields."""

    @pytest.mark.asyncio
    async def test_log_null_optional_fields(self, db_session):
        log = await _insert_log(
            db_session,
            processing_job_id=None,
            user_id=None,
        )

        result = await db_session.execute(select(AuditLog).where(AuditLog.id == log.id))
        row = result.scalar_one()
        assert row.processing_job_id is None
        assert row.user_id is None
        # Core fields should still be present
        assert row.question_text is not None
