"""
Audit logging — every answer is recorded to SQLite.
"""

import csv
import io
import json
from datetime import datetime
from typing import Optional

from sqlalchemy import select, func, and_, desc
from sqlalchemy.ext.asyncio import AsyncSession

from models import AuditLog


async def log_answer(
    db: AsyncSession,
    question_text: str,
    answer_text: str,
    confidence_score: float,
    confidence_tier: str,
    kb_version_used: int,
    llm_model_used: str,
    source_citations: list,
    was_translated: bool,
    original_language: str,
    processing_job_id: Optional[int],
    user_id: Optional[int],
    commit: bool = True,
) -> AuditLog:
    log = AuditLog(
        question_text=question_text,
        answer_text=answer_text,
        confidence_score=confidence_score,
        confidence_tier=confidence_tier,
        kb_version_used=kb_version_used,
        llm_model_used=llm_model_used,
        source_citations=json.dumps(source_citations) if isinstance(source_citations, list) else source_citations,
        was_translated=was_translated,
        original_language=original_language,
        processing_job_id=processing_job_id,
        user_id=user_id,
        timestamp=datetime.utcnow(),
    )
    db.add(log)
    if commit:
        await db.commit()
        await db.refresh(log)
    return log


async def get_audit_logs(
    db: AsyncSession, filters: dict
) -> tuple[list[AuditLog], int]:
    conditions = []

    if filters.get("confidence_tier"):
        conditions.append(AuditLog.confidence_tier == filters["confidence_tier"])

    if filters.get("flagged_only"):
        conditions.append(AuditLog.confidence_tier == "no_answer")

    if filters.get("kb_version"):
        conditions.append(AuditLog.kb_version_used == int(filters["kb_version"]))

    if filters.get("user_id"):
        conditions.append(AuditLog.user_id == int(filters["user_id"]))

    if filters.get("date_from"):
        conditions.append(AuditLog.timestamp >= datetime.fromisoformat(filters["date_from"]))

    if filters.get("date_to"):
        dt = datetime.fromisoformat(filters["date_to"])
        conditions.append(AuditLog.timestamp <= dt.replace(hour=23, minute=59, second=59))

    where_clause = and_(*conditions) if conditions else True

    # Count
    count_q = select(func.count(AuditLog.id)).where(where_clause)
    total = (await db.execute(count_q)).scalar() or 0

    # Paginate
    page = filters.get("page", 1)
    per_page = filters.get("per_page", 20)
    offset = (page - 1) * per_page

    q = (
        select(AuditLog)
        .where(where_clause)
        .order_by(desc(AuditLog.timestamp))
        .offset(offset)
        .limit(per_page)
    )
    result = await db.execute(q)
    logs = result.scalars().all()

    return logs, total


async def export_audit_csv(db: AsyncSession, filters: dict) -> str:
    # Remove pagination for export
    export_filters = {k: v for k, v in filters.items() if k not in ("page", "per_page")}
    export_filters["page"] = 1
    export_filters["per_page"] = 100000

    logs, _ = await get_audit_logs(db, export_filters)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Timestamp", "Question", "Answer", "Confidence Score",
        "Confidence Tier", "KB Version", "LLM Model",
        "Source Citations", "Was Translated", "Original Language",
    ])
    for log in logs:
        writer.writerow([
            log.timestamp.isoformat() if log.timestamp else "",
            log.question_text,
            log.answer_text,
            log.confidence_score,
            log.confidence_tier,
            log.kb_version_used,
            log.llm_model_used,
            log.source_citations,
            log.was_translated,
            log.original_language,
        ])

    return output.getvalue()
