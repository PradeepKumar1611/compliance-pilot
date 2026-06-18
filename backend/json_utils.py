"""
Robust JSON extraction from LLM output.

LLMs wrap JSON in prose, ```fences```, or trailing commentary. The greedy
``re.search(r'\\[.*\\]')`` approach used previously mis-parses nested structures
and multiple arrays. ``extract_json`` does a string-aware balanced-bracket scan
to pull out the first complete JSON value of the expected type.
"""

import json
import logging

logger = logging.getLogger(__name__)


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        # drop the opening fence line (``` or ```json) and the closing fence
        first_nl = t.find("\n")
        if first_nl != -1:
            t = t[first_nl + 1 :]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t


def _find_balanced(text: str, open_ch: str, close_ch: str):
    """Return the first balanced (open_ch..close_ch) substring, respecting
    JSON string literals and escapes. None if not found."""
    start = text.find(open_ch)
    if start == -1:
        return None
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def extract_json(text, expect=None):
    """Extract and parse the first JSON value of the expected type from `text`.

    expect: ``list``, ``dict``, or None (accept either, preferring whichever
    bracket appears first). Returns the parsed value, or None on failure.
    """
    if not text or not isinstance(text, str):
        return None
    cleaned = _strip_fences(text)

    candidates = []
    if expect is list:
        candidates = [("[", "]")]
    elif expect is dict:
        candidates = [("{", "}")]
    else:
        # pick whichever opens first
        ai, oi = cleaned.find("["), cleaned.find("{")
        if ai == -1 and oi == -1:
            candidates = []
        elif oi == -1 or (ai != -1 and ai < oi):
            candidates = [("[", "]"), ("{", "}")]
        else:
            candidates = [("{", "}"), ("[", "]")]

    for open_ch, close_ch in candidates:
        snippet = _find_balanced(cleaned, open_ch, close_ch)
        if not snippet:
            continue
        try:
            parsed = json.loads(snippet)
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("extract_json: failed to parse %s..%s: %s", open_ch, close_ch, e)
            continue
        if expect is list and not isinstance(parsed, list):
            continue
        if expect is dict and not isinstance(parsed, dict):
            continue
        return parsed

    logger.warning("extract_json: no valid JSON (%s) in LLM output: %.120r", expect, text)
    return None
