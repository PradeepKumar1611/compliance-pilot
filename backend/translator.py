"""
Multilingual support — detect language, translate via Claude Code CLI or Ollama.
"""

import asyncio

import httpx
from langdetect import detect, LangDetectException


def detect_language(text: str) -> str:
    """Detect the language of the input text. Returns ISO 639-1 code."""
    try:
        if not text or len(text.strip()) < 3:
            return "en"
        return detect(text)
    except LangDetectException:
        return "en"


async def _translate_with_claude_code(prompt: str) -> str:
    """Translate using Claude Code CLI (no API key needed)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", prompt, "--output-format", "text",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        if proc.returncode == 0:
            return stdout.decode("utf-8").strip()
        return ""
    except Exception:
        return ""


async def _translate_with_ollama(prompt: str, ollama_url: str, model: str) -> str:
    """Translate using Ollama."""
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{ollama_url}/api/generate",
                json={"model": model, "prompt": prompt, "stream": False},
            )
            if resp.status_code == 200:
                return resp.json().get("response", "").strip()
            return ""
    except Exception:
        return ""


async def _translate(prompt: str, ollama_url: str, model: str,
                     provider: str = "claude_code", **kwargs) -> str:
    """Route translation to the right provider."""
    if provider == "claude_code":
        result = await _translate_with_claude_code(prompt)
        if result:
            return result
        # Fallback to Ollama if Claude Code fails
        return await _translate_with_ollama(prompt, ollama_url, model)
    else:
        return await _translate_with_ollama(prompt, ollama_url, model)


async def translate_to_english(
    text: str, source_lang: str, ollama_url: str, model: str,
    provider: str = "claude_code", **kwargs,
) -> str:
    """Translate text to English. Skip if already English."""
    if source_lang == "en":
        return text

    prompt = (
        f"Translate the following text from {source_lang} to English. "
        f"Return ONLY the translated text, nothing else.\n\n"
        f"Text: {text}"
    )

    result = await _translate(prompt, ollama_url, model, provider)
    return result if result else text


async def translate_from_english(
    text: str, target_lang: str, ollama_url: str, model: str,
    provider: str = "claude_code", **kwargs,
) -> str:
    """Translate text from English to the target language."""
    if target_lang == "en":
        return text

    prompt = (
        f"Translate the following English text to {target_lang}. "
        f"Return ONLY the translated text, nothing else.\n\n"
        f"Text: {text}"
    )

    result = await _translate(prompt, ollama_url, model, provider)
    return result if result else text
