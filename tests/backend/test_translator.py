"""
Tests for translator.py — language detection and translation via Ollama.
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from translator import detect_language, translate_to_english, translate_from_english


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestDetectEnglish:
    """Test that English text is detected as 'en'."""

    def test_detect_english(self):
        result = detect_language("What is your policy?")
        assert result == "en"

    def test_detect_english_long(self):
        result = detect_language("How does your organization handle data breaches and security incidents?")
        assert result == "en"


class TestDetectTamil:
    """Test that Tamil text is detected correctly."""

    def test_detect_tamil(self):
        tamil_text = "\u0ba4\u0b95\u0bb5\u0bb2\u0bcd \u0baa\u0bbe\u0ba4\u0bc1\u0b95\u0bbe\u0baa\u0bcd\u0baa\u0bc1 \u0b95\u0bca\u0bb3\u0bcd\u0b95\u0bc8 \u0b8e\u0ba9\u0bcd\u0ba9?"
        result = detect_language(tamil_text)
        assert result == "ta"


class TestTranslateToEnglish:
    """Test translation to English via Ollama mock."""

    @pytest.mark.asyncio
    async def test_translate_to_english(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "response": "What is your data protection policy?",
            "done": True,
        }

        with patch("translator.httpx.AsyncClient") as MockClient:
            mock_ctx = AsyncMock()
            mock_ctx.post = AsyncMock(return_value=mock_resp)
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_ctx)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await translate_to_english(
                "\u0ba4\u0b95\u0bb5\u0bb2\u0bcd \u0baa\u0bbe\u0ba4\u0bc1\u0b95\u0bbe\u0baa\u0bcd\u0baa\u0bc1 \u0b95\u0bca\u0bb3\u0bcd\u0b95\u0bc8",
                "ta",
                "http://localhost:11434",
                "llama3.2",
                provider="ollama",
            )

            assert result == "What is your data protection policy?"
            mock_ctx.post.assert_called_once()


class TestTranslateFromEnglish:
    """Test translation from English to another language."""

    @pytest.mark.asyncio
    async def test_translate_from_english(self):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "response": "La politique de conservation est de 7 ans.",
            "done": True,
        }

        with patch("translator.httpx.AsyncClient") as MockClient:
            mock_ctx = AsyncMock()
            mock_ctx.post = AsyncMock(return_value=mock_resp)
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_ctx)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await translate_from_english(
                "The retention policy is 7 years.",
                "fr",
                "http://localhost:11434",
                "llama3.2",
                provider="ollama",
            )

            assert result == "La politique de conservation est de 7 ans."


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestSkipTranslationEnglish:
    """Test that English text is returned unchanged without API call."""

    @pytest.mark.asyncio
    async def test_skip_translation_english(self):
        with patch("translator.httpx.AsyncClient") as MockClient:
            result = await translate_to_english(
                "What is your policy?",
                "en",
                "http://localhost:11434",
                "llama3.2",
            )

            assert result == "What is your policy?"
            # Should NOT have made any HTTP calls
            MockClient.assert_not_called()

    @pytest.mark.asyncio
    async def test_skip_translation_from_english(self):
        with patch("translator.httpx.AsyncClient") as MockClient:
            result = await translate_from_english(
                "Data retained for 7 years.",
                "en",
                "http://localhost:11434",
                "llama3.2",
            )

            assert result == "Data retained for 7 years."
            MockClient.assert_not_called()


class TestDetectLanguageEdgeCases:
    """Edge cases for language detection."""

    def test_detect_empty_string(self):
        result = detect_language("")
        assert result == "en"

    def test_detect_short_string(self):
        result = detect_language("Hi")
        assert result == "en"

    def test_detect_whitespace(self):
        result = detect_language("   ")
        assert result == "en"


# ---------------------------------------------------------------------------
# Failure cases
# ---------------------------------------------------------------------------


class TestTranslationErrorReturnsOriginal:
    """Test that translation errors return original text."""

    @pytest.mark.asyncio
    async def test_translation_error_returns_original(self):
        original = "\u0ba4\u0b95\u0bb5\u0bb2\u0bcd \u0baa\u0bbe\u0ba4\u0bc1\u0b95\u0bbe\u0baa\u0bcd\u0baa\u0bc1"

        with patch("translator.httpx.AsyncClient") as MockClient:
            mock_ctx = AsyncMock()
            mock_ctx.post = AsyncMock(side_effect=Exception("Connection refused"))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_ctx)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await translate_to_english(
                original, "ta", "http://localhost:11434", "llama3.2", provider="ollama"
            )

            assert result == original

    @pytest.mark.asyncio
    async def test_translate_from_english_error_returns_original(self):
        original = "Data retained for 7 years."

        with patch("translator.httpx.AsyncClient") as MockClient:
            mock_ctx = AsyncMock()
            mock_ctx.post = AsyncMock(side_effect=Exception("Timeout"))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_ctx)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await translate_from_english(
                original, "fr", "http://localhost:11434", "llama3.2", provider="ollama"
            )

            assert result == original


class TestTranslationEmptyResponse:
    """Test that empty LLM response returns original text."""

    @pytest.mark.asyncio
    async def test_empty_response_returns_original(self):
        original = "Some non-English text"

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"response": "", "done": True}

        with patch("translator.httpx.AsyncClient") as MockClient:
            mock_ctx = AsyncMock()
            mock_ctx.post = AsyncMock(return_value=mock_resp)
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_ctx)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await translate_to_english(
                original, "ta", "http://localhost:11434", "llama3.2", provider="ollama"
            )

            assert result == original
