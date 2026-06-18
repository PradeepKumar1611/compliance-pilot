"""
Tests for retriever.py — RAG query, confidence tiers, source citations.
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from retriever import query_knowledge_base, classify_confidence


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_settings(**overrides):
    """Build a default settings dict for tests."""
    defaults = {
        "llm_provider": "ollama",
        "ollama_url": "http://localhost:11434",
        "embed_model": "mxbai-embed-large",
        "llm_model": "llama3.2",
        "qdrant_url": "http://localhost:6333",
        "max_chunks": 5,
        "confidence_auto_fill": 0.82,
        "confidence_flag": 0.65,
        "query_expansion_enabled": False,  # Disabled in tests for simplicity
        "reranking_enabled": False,
    }
    defaults.update(overrides)
    return defaults


def _mock_search_point(score, text="Policy text", source_file="policy.pdf", page_number=1):
    """Create a mock Qdrant search result point."""
    point = MagicMock()
    point.id = f"point_{score}_{source_file}"
    point.score = score
    point.payload = {
        "text": text,
        "source_file": source_file,
        "page_number": page_number,
        "section_title": "",
    }
    return point


def _setup_qdrant_mock(MockQdrant, search_results):
    """Configure a mock QdrantClient with collection_exists, get_collection, and query_points."""
    mock_client = MagicMock()
    mock_client.collection_exists.return_value = True

    # Mock collection info — dense-only (v1 style) for simplicity
    mock_config = MagicMock()
    mock_config.config.params.sparse_vectors = None
    mock_config.config.params.vectors = MagicMock()  # Not a dict → dense-only path
    # Make isinstance check for dict return False
    type(mock_config.config.params).vectors = property(lambda self: MagicMock(spec=[]))
    mock_client.get_collection.return_value = mock_config

    # query_points returns an object with .points attribute
    mock_response = MagicMock()
    mock_response.points = search_results
    mock_client.query_points.return_value = mock_response
    MockQdrant.return_value = mock_client
    return mock_client


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestHighConfidenceAnswer:
    """Test high-confidence result returns auto_fill tier with sources."""

    @pytest.mark.asyncio
    async def test_high_confidence_answer(self):
        mock_point = _mock_search_point(0.88, "Data retained for 7 years.", "retention.pdf", 3)

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [mock_point])
            mock_llm.return_value = "Data must be retained for 7 years."

            result = await query_knowledge_base("What is the retention policy?", 1, _make_settings())

            assert result["confidence_tier"] == "auto_fill"
            assert result["confidence_score"] == 0.88
            assert result["answer"] == "Data must be retained for 7 years."
            assert len(result["sources"]) == 1
            assert result["sources"][0]["source_file"] == "retention.pdf"


class TestSourceCitationsIncluded:
    """Test that sources contain source_file and page_number."""

    @pytest.mark.asyncio
    async def test_source_citations_included(self):
        points = [
            _mock_search_point(0.90, "Text A", "fileA.pdf", 1),
            _mock_search_point(0.85, "Text B", "fileB.pdf", 5),
        ]

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, points)
            mock_llm.return_value = "Combined answer."

            result = await query_knowledge_base("question", 1, _make_settings())

            assert len(result["sources"]) == 2
            assert result["sources"][0]["source_file"] == "fileA.pdf"
            assert result["sources"][0]["page_number"] == 1
            assert result["sources"][1]["source_file"] == "fileB.pdf"
            assert result["sources"][1]["page_number"] == 5
            assert all("source_file" in s for s in result["sources"])


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestMediumConfidence:
    """Test medium confidence returns needs_review tier."""

    @pytest.mark.asyncio
    async def test_medium_confidence(self):
        mock_point = _mock_search_point(0.72)

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [mock_point])
            mock_llm.return_value = "Some answer with moderate confidence."

            result = await query_knowledge_base("question", 1, _make_settings())

            assert result["confidence_tier"] == "needs_review"
            assert 0.65 <= result["confidence_score"] < 0.82


class TestClassifyConfidence:
    """Unit tests for classify_confidence function."""

    def test_auto_fill(self):
        assert classify_confidence(0.90, 0.82, 0.65) == "auto_fill"

    def test_needs_review(self):
        assert classify_confidence(0.75, 0.82, 0.65) == "needs_review"

    def test_no_answer(self):
        assert classify_confidence(0.50, 0.82, 0.65) == "no_answer"

    def test_boundary_auto_fill(self):
        assert classify_confidence(0.82, 0.82, 0.65) == "auto_fill"

    def test_boundary_needs_review(self):
        assert classify_confidence(0.65, 0.82, 0.65) == "needs_review"


class TestNoAnswerFoundToken:
    """Test that LLM returning NO_ANSWER_FOUND forces confidence to 0.0."""

    @pytest.mark.asyncio
    async def test_no_answer_found_token(self):
        mock_point = _mock_search_point(0.88)

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [mock_point])
            mock_llm.return_value = "NO_ANSWER_FOUND"

            result = await query_knowledge_base("question", 1, _make_settings())

            assert result["confidence_score"] == 0.0
            assert result["confidence_tier"] == "no_answer"
            assert result["answer"] == ""


# ---------------------------------------------------------------------------
# Failure cases
# ---------------------------------------------------------------------------


class TestLowConfidenceAnswer:
    """Test low-confidence result returns no_answer tier."""

    @pytest.mark.asyncio
    async def test_low_confidence_answer(self):
        mock_point = _mock_search_point(0.4)

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [mock_point])
            mock_llm.return_value = "Vague answer."

            result = await query_knowledge_base("question", 1, _make_settings())

            assert result["confidence_tier"] == "no_answer"
            assert result["confidence_score"] < 0.65


class TestEmptySearchResults:
    """Test that empty Qdrant results return no_answer tier."""

    @pytest.mark.asyncio
    async def test_empty_search_results(self):
        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [])

            result = await query_knowledge_base("question", 1, _make_settings())

            assert result["confidence_tier"] == "no_answer"
            assert result["confidence_score"] == 0.0
            assert result["sources"] == []
            assert result["answer"] == ""


# ---------------------------------------------------------------------------
# Soft-retry fallback (Option C, flavor 1) — applies when strict pass says
# NO_ANSWER_FOUND but the context establishes a general capability.
# ---------------------------------------------------------------------------


class TestSoftRetryFallback:
    """Fallback re-call on NO_ANSWER_FOUND with a softer system prompt."""

    @pytest.mark.asyncio
    async def test_fallback_succeeds_forces_needs_review_and_caps_confidence(self):
        """Primary says NO_ANSWER_FOUND; fallback returns a real answer.
        Result must be tier=needs_review with confidence capped at 0.70."""
        # High retrieval confidence so we can verify the cap is applied.
        mock_point = _mock_search_point(0.90, "All customer data is encrypted at rest using AES-256.")

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [mock_point])
            # First call: strict refusal. Second call: fallback succeeds.
            mock_llm.side_effect = [
                "NO_ANSWER_FOUND",
                "In general, yes. All customer data is encrypted at rest using AES-256.",
            ]

            result = await query_knowledge_base(
                "Is data in the analytics database encrypted?", 1, _make_settings()
            )

            # Both calls happened
            assert mock_llm.await_count == 2
            # Fallback answer surfaced
            assert "In general" in result["answer"]
            # Forced needs_review regardless of retrieval score
            assert result["confidence_tier"] == "needs_review"
            # Capped at SOFT_RETRY_CONFIDENCE_CAP (0.70)
            from retriever import SOFT_RETRY_CONFIDENCE_CAP
            assert result["confidence_score"] <= SOFT_RETRY_CONFIDENCE_CAP
            assert result["confidence_score"] == SOFT_RETRY_CONFIDENCE_CAP

            # Second call must have used the FALLBACK system prompt
            from retriever import FALLBACK_SYSTEM_PROMPT
            second_call_kwargs = mock_llm.await_args_list[1].kwargs
            assert second_call_kwargs.get("system_prompt") == FALLBACK_SYSTEM_PROMPT

    @pytest.mark.asyncio
    async def test_fallback_also_fails_returns_no_answer(self):
        """Primary AND fallback both return NO_ANSWER_FOUND. Result: no_answer, 0.0."""
        mock_point = _mock_search_point(0.88)

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [mock_point])
            mock_llm.side_effect = ["NO_ANSWER_FOUND", "NO_ANSWER_FOUND"]

            result = await query_knowledge_base("unanswerable q", 1, _make_settings())

            assert mock_llm.await_count == 2
            assert result["confidence_tier"] == "no_answer"
            assert result["confidence_score"] == 0.0
            assert result["answer"] == ""

    @pytest.mark.asyncio
    async def test_primary_success_does_not_trigger_fallback(self):
        """When the strict pass answers, fallback must NOT run (additive-only)."""
        mock_point = _mock_search_point(0.88, "Retention is 7 years.")

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [mock_point])
            mock_llm.return_value = "Data is retained for 7 years."

            result = await query_knowledge_base("retention policy?", 1, _make_settings())

            # Exactly ONE call — no fallback
            assert mock_llm.await_count == 1
            assert result["confidence_tier"] == "auto_fill"
            assert result["confidence_score"] == 0.88
            assert result["answer"] == "Data is retained for 7 years."

    @pytest.mark.asyncio
    async def test_fallback_cap_does_not_raise_low_score(self):
        """If retrieval confidence was LOW (e.g. 0.40), the cap must not
        artificially raise it to 0.70 — the cap is a ceiling, not a floor."""
        mock_point = _mock_search_point(0.40)

        with patch("retriever.get_embedding", new_callable=AsyncMock) as mock_embed, \
             patch("retriever.QdrantClient") as MockQdrant, \
             patch("retriever._call_llm", new_callable=AsyncMock) as mock_llm:

            mock_embed.return_value = [0.1] * 1024
            _setup_qdrant_mock(MockQdrant, [mock_point])
            mock_llm.side_effect = [
                "NO_ANSWER_FOUND",
                "In general, the policy applies.",
            ]

            result = await query_knowledge_base("edge q", 1, _make_settings())

            # Score stays at 0.40 (the original retrieval score), NOT bumped up
            assert result["confidence_score"] == 0.40
            # But tier is still forced to needs_review
            assert result["confidence_tier"] == "needs_review"
            assert "In general" in result["answer"]
