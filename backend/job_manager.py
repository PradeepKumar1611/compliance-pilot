"""
Background job tracking for questionnaire processing.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from models import ProcessingJob


async def create_job(db: AsyncSession, user_id: int, filename: str) -> int:
    job = ProcessingJob(
        user_id=user_id,
        filename=filename,
        status="queued",
        created_at=datetime.utcnow(),
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job.id


async def update_job_status(
    db: AsyncSession,
    job_id: int,
    status: str,
    processed_questions: Optional[int] = None,
    error_message: Optional[str] = None,
    output_file_path: Optional[str] = None,
    commit: bool = True,
) -> None:
    result = await db.execute(select(ProcessingJob).where(ProcessingJob.id == job_id))
    job = result.scalar_one_or_none()
    if not job:
        return

    job.status = status

    if processed_questions is not None:
        job.processed_questions = processed_questions

    if error_message is not None:
        job.error_message = error_message

    if output_file_path is not None:
        job.output_file_path = output_file_path

    if status == "done":
        job.completed_at = datetime.utcnow()

    if status in ("failed", "cancelled"):
        job.completed_at = datetime.utcnow()

    if commit:
        await db.commit()


async def get_job(db: AsyncSession, job_id: int) -> Optional[ProcessingJob]:
    result = await db.execute(select(ProcessingJob).where(ProcessingJob.id == job_id))
    return result.scalar_one_or_none()


async def get_user_jobs(db: AsyncSession, user_id: int) -> list[ProcessingJob]:
    result = await db.execute(
        select(ProcessingJob)
        .where(ProcessingJob.user_id == user_id)
        .order_by(desc(ProcessingJob.created_at))
    )
    return result.scalars().all()
