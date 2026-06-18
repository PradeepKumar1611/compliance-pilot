"""
Compliance Pilot — LLM Skills module.
Supports both Claude Code CLI and Ollama as LLM providers.
Falls back to Python heuristics when LLM is unavailable.
"""

import asyncio
import json
import re
from typing import List, Dict, Optional

import httpx


# ---------------------------------------------------------------------------
# Core: Call LLM (routes to Claude Code CLI or Ollama based on provider)
# ---------------------------------------------------------------------------

async def _call_llm(prompt: str, provider: str = "claude_code",
                    ollama_url: str = "http://localhost:11434",
                    ollama_model: str = "llama3.2",
                    timeout: int = 120) -> Optional[str]:
    """Call the configured LLM provider. Returns response text or None on failure."""
    if provider == "ollama":
        return await _call_ollama(prompt, ollama_url, ollama_model, timeout)
    else:
        return await _call_claude(prompt, timeout)


async def _call_claude(prompt: str, timeout: int = 120) -> Optional[str]:
    """Call Claude Code CLI."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", prompt, "--output-format", "text",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        if proc.returncode == 0:
            return stdout.decode("utf-8").strip()
        print(f"Claude CLI error (exit {proc.returncode}): {stderr.decode()[:200]}")
        return None
    except asyncio.TimeoutError:
        print("Claude CLI timed out")
        return None
    except FileNotFoundError:
        print("Claude CLI not found in PATH")
        return None
    except Exception as e:
        print(f"Claude CLI error: {e}")
        return None


def _no_proxy_client(timeout: float = 120.0) -> httpx.AsyncClient:
    t = httpx.AsyncHTTPTransport()
    return httpx.AsyncClient(timeout=timeout, mounts={"http://localhost": t, "http://127.0.0.1": t})


async def _call_ollama(prompt: str, ollama_url: str, model: str, timeout: int = 120) -> Optional[str]:
    """Call Ollama LLM."""
    try:
        async with _no_proxy_client(float(timeout)) as client:
            resp = await client.post(
                f"{ollama_url}/api/generate",
                json={"model": model, "prompt": prompt, "stream": False},
            )
            resp.raise_for_status()
            return resp.json().get("response", "").strip()
    except Exception as e:
        print(f"Ollama error: {e}")
        return None


def _extract_json_from_response(text: str) -> Optional[str]:
    """Extract JSON from a response that may contain markdown code blocks."""
    if not text:
        return None
    match = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
    if match:
        return match.group(1).strip()
    text = text.strip()
    if text.startswith("[") or text.startswith("{"):
        return text
    return None


def _get_llm_settings() -> dict:
    """Load LLM provider settings from the database at runtime."""
    try:
        from config import settings
        return {
            "provider": settings.LLM_PROVIDER,
            "ollama_url": settings.OLLAMA_URL,
            "ollama_model": settings.LLM_MODEL,
        }
    except Exception:
        return {"provider": "claude_code", "ollama_url": "http://localhost:11434", "ollama_model": "llama3.2"}


async def _call_llm_generic(prompt: str, settings_dict: dict) -> Optional[str]:
    """Call LLM using the standard settings dict format (used by main.py chat)."""
    provider = settings_dict.get("llm_provider", "claude_code")
    ollama_url = settings_dict.get("ollama_url", "http://localhost:11434")
    ollama_model = settings_dict.get("llm_model", "llama3.2")
    return await _call_llm(prompt, provider, ollama_url, ollama_model)


# ---------------------------------------------------------------------------
# Skill 0: Detect XLSX Layout
# ---------------------------------------------------------------------------


async def detect_xlsx_layout_with_llm(sheet_preview: str, sheet_name: str,
                                       settings_dict: dict = None) -> Optional[list]:
    """Ask LLM to analyze spreadsheet layout and identify table regions with question/answer columns.
    Returns a LIST of table regions, e.g.:
    [{"question_col": "B", "answer_col": "C", "start_row": 2, "end_row": 20, "section": "Security"}]
    Each region has its own question column, answer column, and row range."""
    s = settings_dict or {"provider": "claude_code", "ollama_url": "http://localhost:11434", "ollama_model": "llama3.2"}

    prompt = f"""Analyze this spreadsheet data from sheet "{sheet_name}". The rows below show the content with column letters.

{sheet_preview}

Your task: Identify ALL table regions in this sheet. A sheet may have ONE or MULTIPLE tables/sections, each with its own question and answer columns.

For EACH table region, identify:
- question_col: the column letter containing questions/requirements (the longest text)
- answer_col: the column letter where responses should go (usually has header like "Response", "Answer", or is empty and next to questions)
- start_row: first row with an actual question (not a header)
- end_row: last row with a question (use the last row number you can see, or 9999 if unsure)
- section: a short name for this section (from header or context)

Rules:
- Ignore columns with only row numbers (1, 2, 3...) or short labels/IDs
- If there is only ONE table, return an array with one object
- If there are MULTIPLE tables separated by empty rows or different headers, return multiple objects
- end_row can be 9999 if you're not sure where the table ends

Return ONLY a JSON array:
[{{"question_col": "B", "answer_col": "C", "start_row": 2, "end_row": 9999, "section": "Main"}}]

Return ONLY the JSON array, no explanation."""

    try:
        response = await _call_llm(prompt, s["provider"], s["ollama_url"], s["ollama_model"], timeout=30)
        if not response:
            return None

        from json_utils import extract_json
        # Primary: a JSON array of table regions.
        tables = extract_json(response, expect=list)
        if isinstance(tables, list) and len(tables) > 0:
            validated = []
            for t in tables:
                if isinstance(t, dict) and all(k in t for k in ("question_col", "answer_col", "start_row")):
                    validated.append({
                        "question_col": str(t["question_col"]).upper().strip(),
                        "answer_col": str(t["answer_col"]).upper().strip(),
                        "start_row": int(t["start_row"]),
                        "end_row": int(t.get("end_row", 9999)),
                        "section": str(t.get("section", "")),
                    })
            if validated:
                return validated

        # Fallback: a single object (backward compat).
        result = extract_json(response, expect=dict)
        if isinstance(result, dict) and all(k in result for k in ("question_col", "answer_col")):
            return [{
                "question_col": str(result["question_col"]).upper().strip(),
                "answer_col": str(result["answer_col"]).upper().strip(),
                "start_row": int(result.get("start_row", result.get("first_data_row", 2))),
                "end_row": int(result.get("end_row", 9999)),
                "section": str(result.get("section", "")),
            }]
    except Exception as e:
        print(f"LLM layout detection failed: {e}")
    return None


# ---------------------------------------------------------------------------
# Skill 1: Extract Questions from Document
# ---------------------------------------------------------------------------

async def extract_questions_with_llm(document_text: str, settings_dict: dict = None) -> Optional[List[Dict]]:
    """
    Use LLM to identify all questions and requests for information in a document.
    Returns list of {"question": str, "index": int} or None on failure.
    """
    if not settings_dict:
        settings_dict = _get_llm_settings()

    max_chars = 15000
    truncated = document_text[:max_chars] if len(document_text) > max_chars else document_text

    prompt = f"""You are analyzing a compliance questionnaire document. Identify every question, request for information, or field that needs an answer from a vendor.

Rules:
- Include questions ending with ?
- Include requests like "Please provide...", "Please describe...", "Describe how..."
- Include fields that explicitly ask for information even without ? mark
- SKIP section headings, labels, and metadata (e.g., "Security Considerations", "Data Elements")
- SKIP checkbox items that are just options without a question (e.g., "___ Anonymization -")
- SKIP items shorter than 15 characters that are just labels
- Each question should be the full text of the request

Return ONLY a valid JSON array of objects, each with a "question" field.
Example: [{{"question": "What is your data retention policy?"}}, {{"question": "Please provide security documentation"}}]

Document text:
\"\"\"
{truncated}
\"\"\"

Return ONLY the JSON array, no other text or explanation."""

    response = await _call_llm(
        prompt,
        provider=settings_dict.get("provider", "claude_code"),
        ollama_url=settings_dict.get("ollama_url", "http://localhost:11434"),
        ollama_model=settings_dict.get("ollama_model", "llama3.2"),
    )

    if not response:
        return None

    json_text = _extract_json_from_response(response)
    if not json_text:
        return None

    try:
        questions = json.loads(json_text)
        if isinstance(questions, list):
            return [
                {"question": q.get("question", q.get("q", "")), "index": i}
                for i, q in enumerate(questions)
                if isinstance(q, dict) and (q.get("question") or q.get("q"))
            ]
    except json.JSONDecodeError:
        pass

    return None


# ---------------------------------------------------------------------------
# Skill 2: Convert to Clean Markdown
# ---------------------------------------------------------------------------

async def convert_to_markdown_with_llm(raw_text: str, source_filename: str,
                                        settings_dict: dict = None) -> Optional[str]:
    """
    Use LLM to convert raw document text into clean, well-structured markdown.
    Processes in segments to avoid truncation — no data loss.
    Returns markdown string or None on failure.
    """
    if not settings_dict:
        settings_dict = _get_llm_settings()

    if len(raw_text) < 200:
        return None

    segment_size = 6000  # chars per LLM call — safe for 3B models

    # If text fits in one segment, process directly
    if len(raw_text) <= segment_size:
        return await _convert_segment_to_markdown(raw_text, source_filename, settings_dict)

    # Split into segments at paragraph boundaries
    segments = _split_into_segments(raw_text, segment_size)
    md_parts = []

    for i, segment in enumerate(segments):
        is_first = (i == 0)
        md = await _convert_segment_to_markdown(
            segment, source_filename if is_first else f"{source_filename} (part {i+1})",
            settings_dict
        )
        if md:
            md_parts.append(md)
        else:
            # Fallback: use raw text for this segment
            md_parts.append(segment)

    return "\n\n---\n\n".join(md_parts) if md_parts else None


def _split_into_segments(text: str, max_chars: int) -> list:
    """Split text into segments at paragraph boundaries. No data lost."""
    paragraphs = text.split("\n\n")
    segments = []
    current = ""

    for para in paragraphs:
        if len(current) + len(para) + 2 <= max_chars:
            current = f"{current}\n\n{para}" if current else para
        else:
            if current.strip():
                segments.append(current.strip())
            # If single paragraph is too long, split by lines
            if len(para) > max_chars:
                lines = para.split("\n")
                sub = ""
                for line in lines:
                    if len(sub) + len(line) + 1 <= max_chars:
                        sub = f"{sub}\n{line}" if sub else line
                    else:
                        if sub.strip():
                            segments.append(sub.strip())
                        sub = line
                if sub.strip():
                    segments.append(sub.strip())
                current = ""
            else:
                current = para

    if current.strip():
        segments.append(current.strip())

    return segments


async def _convert_segment_to_markdown(text: str, source_filename: str,
                                        settings_dict: dict) -> Optional[str]:
    """Convert a single text segment to markdown using LLM."""
    prompt = f"""Convert the following raw document text into clean, well-structured Markdown for a knowledge base.

Rules:
- Use proper heading hierarchy (# for title, ## for sections, ### for subsections)
- Use bullet points for lists
- Use **bold** for key terms
- Remove any HTML tags, JSON syntax, or metadata noise
- Keep ALL factual content intact — do not summarize or remove information
- If the text contains Q&A pairs, format them clearly
- Keep it clean and professional

Source file: {source_filename}

Raw text:
\"\"\"
{text}
\"\"\"

Return ONLY the markdown, no explanation or preamble."""

    return await _call_llm(
        prompt,
        provider=settings_dict.get("provider", "claude_code"),
        ollama_url=settings_dict.get("ollama_url", "http://localhost:11434"),
        ollama_model=settings_dict.get("ollama_model", "llama3.2"),
    )


# ---------------------------------------------------------------------------
# Skill 3: Post-Process Answer
# ---------------------------------------------------------------------------

async def clean_answer_with_llm(raw_answer: str, question: str,
                                 settings_dict: dict = None) -> Optional[str]:
    """
    Clean up a raw LLM answer for inclusion in a professional compliance document.
    Returns cleaned answer or None on failure.
    """
    if not settings_dict:
        settings_dict = _get_llm_settings()

    if not raw_answer or len(raw_answer) < 10:
        return None

    prompt = f"""Clean up this compliance answer for a professional questionnaire document.

Rules:
- Remove boilerplate phrases like "Based on the provided context", "According to the context"
- Be direct and concise — start with the actual answer
- Keep all factual information and specific details (policy names, standards, numbers)
- Use bullet points for lists of items
- Keep it under 200 words
- Do NOT add information that isn't in the original answer
- If the answer contains source citations in brackets, keep them

Question: {question}

Raw answer:
\"\"\"
{raw_answer}
\"\"\"

Return ONLY the cleaned answer, no explanation."""

    return await _call_llm(
        prompt,
        provider=settings_dict.get("provider", "claude_code"),
        ollama_url=settings_dict.get("ollama_url", "http://localhost:11434"),
        ollama_model=settings_dict.get("ollama_model", "llama3.2"),
        timeout=30,
    )
