"""
Tests for ingest.py — chunking, embeddings, versioned collections.
"""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock

from ingest import (
    chunk_document,
    get_embedding,
    get_collection_name,
    get_or_create_collection,
    ingest_document,
)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestChunkDocument:
    """Test that chunk_document produces chunks with correct metadata."""

    def test_chunk_document(self):
        content = "# Policy\n\n" + "This is a test policy document. " * 50
        chunks = chunk_document(content, "policy.pdf")

        assert len(chunks) >= 1
        for chunk in chunks:
            assert "text" in chunk
            assert chunk["source_file"] == "policy.pdf"
            assert "page_number" in chunk
            assert "chunk_index" in chunk
            assert "ingested_at" in chunk

    def test_chunk_metadata_source_file(self):
        content = "# Retention\n\nData must be retained for 7 years."
        chunks = chunk_document(content, "data_retention.docx")
        assert all(c["source_file"] == "data_retention.docx" for c in chunks)

    def test_chunk_with_sections(self):
        content = "# Section 1\n\nContent one.\n\n# Section 2\n\nContent two."
        chunks = chunk_document(content, "doc.pdf")
        assert len(chunks) >= 2
        assert chunks[0]["section_title"] == "Section 1"
        assert chunks[1]["section_title"] == "Section 2"


class TestGetEmbedding:
    """Test that get_embedding calls Ollama and returns a vector."""

    @pytest.mark.asyncio
    async def test_get_embedding(self, mock_embedding_response):
        with patch("ingest.httpx.AsyncClient") as MockClient:
            mock_ctx = AsyncMock()
            mock_ctx.post = AsyncMock(return_value=mock_embedding_response)
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_ctx)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await get_embedding("test text", "http://localhost:11434", "nomic-embed-text")

            assert isinstance(result, list)
            assert len(result) == 1024
            assert all(isinstance(v, float) for v in result)


class TestVersionedCollectionNaming:
    """Test versioned collection naming."""

    def test_collection_name_v1(self):
        assert get_collection_name(1) == "policy_v1"

    def test_collection_name_v2(self):
        assert get_collection_name(2) == "policy_v2"

    def test_get_or_create_collection_creates(self):
        with patch("ingest.QdrantClient") as MockQdrant:
            mock_client = MagicMock()
            mock_client.collection_exists.return_value = False
            MockQdrant.return_value = mock_client

            client, name = get_or_create_collection("http://localhost:6333", 1)

            assert name == "policy_v1"
            mock_client.create_collection.assert_called_once()

    def test_get_or_create_collection_exists(self):
        with patch("ingest.QdrantClient") as MockQdrant:
            mock_client = MagicMock()
            mock_client.collection_exists.return_value = True
            MockQdrant.return_value = mock_client

            client, name = get_or_create_collection("http://localhost:6333", 2)

            assert name == "policy_v2"
            mock_client.create_collection.assert_not_called()


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestIngestEmptyDocument:
    """Test that an empty document returns 0 chunks."""

    def test_ingest_empty_content(self):
        chunks = chunk_document("", "empty.pdf")
        assert chunks == []

    def test_ingest_whitespace_content(self):
        chunks = chunk_document("   \n\t  ", "blank.pdf")
        assert chunks == []

    def test_ingest_none_content(self):
        chunks = chunk_document(None, "none.pdf")
        assert chunks == []


class TestChunkLongContent:
    """Test that long content is split into multiple chunks without data loss."""

    def test_long_content_splits(self):
        # Create content larger than MAX_CHUNK_CHARS
        content = "# Big Doc\n\n" + ("This is a sentence. " * 200)
        chunks = chunk_document(content, "doc.pdf")
        assert len(chunks) >= 2
        # With 150-char overlap, chunks can be slightly over MAX_CHUNK_CHARS
        assert all(len(c["text"]) <= 1800 + 200 for c in chunks)


# ---------------------------------------------------------------------------
# Failure cases
# ---------------------------------------------------------------------------


class TestIngestConnectionError:
    """Test graceful failure when Ollama is unreachable."""

    @pytest.mark.asyncio
    async def test_ingest_connection_error(self):
        with patch("ingest.httpx.AsyncClient") as MockClient:
            mock_ctx = AsyncMock()
            mock_ctx.post = AsyncMock(side_effect=httpx.ConnectError("Connection refused"))
            MockClient.return_value.__aenter__ = AsyncMock(return_value=mock_ctx)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            with pytest.raises(Exception):
                await get_embedding("text", "http://localhost:11434", "nomic-embed-text")


# Need httpx imported for the error class
import httpx
