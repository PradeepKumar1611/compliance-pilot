"""
Tests for extractor.py — question extraction from DOCX, XLSX, TXT, PDF.
"""

import pytest
import tempfile
from pathlib import Path

from extractor import extract_questions


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestExtractFromDocxTable:
    """Test extraction from DOCX with Q&A table."""

    def test_extract_from_docx_table(self, sample_docx):
        questions = extract_questions(str(sample_docx), "docx")

        assert len(questions) == 3
        assert questions[0]["question_text"] == "What is your data retention policy?"
        assert questions[1]["question_text"] == "How do you handle data breaches?"
        assert questions[2]["question_text"] == "What encryption standards do you use?"

        # Verify location_info
        for q in questions:
            loc = q["location_info"]
            assert loc["type"] == "docx_table"
            assert "table_index" in loc
            assert "row_index" in loc
            assert "answer_col" in loc


class TestExtractFromXlsx:
    """Test extraction from XLSX questionnaire."""

    def test_extract_from_xlsx(self, sample_xlsx):
        questions = extract_questions(str(sample_xlsx), "xlsx")

        assert len(questions) == 3
        assert questions[0]["question_text"] == "What is your data retention policy?"

        for q in questions:
            loc = q["location_info"]
            assert loc["type"] == "xlsx"
            assert "row" in loc
            assert loc["answer_col"] == "B"


class TestExtractFromTxt:
    """Test extraction from plain text."""

    def test_extract_from_txt(self, sample_txt):
        questions = extract_questions(str(sample_txt), "txt")

        assert len(questions) == 4
        assert questions[0]["question_text"] == "What is your data retention policy?"
        assert questions[3]["question_text"] == "Do you have a disaster recovery plan?"

        for q in questions:
            loc = q["location_info"]
            assert loc["type"] == "txt"
            assert "line_number" in loc


class TestExtractFromPdf:
    """Test extraction from PDF."""

    def test_extract_from_pdf(self, sample_pdf):
        questions = extract_questions(str(sample_pdf), "pdf")

        # PDF has 3 questions (after removing numbering)
        assert len(questions) >= 1
        texts = [q["question_text"] for q in questions]
        assert any("data retention" in t.lower() for t in texts)

        for q in questions:
            loc = q["location_info"]
            assert loc["type"] == "pdf"
            assert "page_number" in loc


class TestExtractFromFillablePdf:
    """Test extraction from fillable PDF with form fields."""

    def test_extract_form_fields(self, sample_fillable_pdf):
        questions = extract_questions(str(sample_fillable_pdf), "pdf")

        # Should detect form fields
        assert len(questions) >= 1

        # Check that form field type is used
        for q in questions:
            loc = q["location_info"]
            assert loc["type"] == "pdf_form_field"
            assert "field_name" in loc
            assert "page_number" in loc

    def test_form_field_names_preserved(self, sample_fillable_pdf):
        questions = extract_questions(str(sample_fillable_pdf), "pdf")
        field_names = [q["location_info"]["field_name"] for q in questions]
        assert "data_retention_policy" in field_names


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


class TestExtractEmptyDoc:
    """Test extraction from empty document returns empty list."""

    def test_extract_empty_doc(self, empty_docx):
        questions = extract_questions(str(empty_docx), "docx")
        assert questions == []


class TestExtractMixedContent:
    """Test extraction handles documents with non-question content."""

    def test_non_question_lines_skipped(self, tmp_path):
        content = """Header line
Some description text that is not a question.
What is your data retention policy?
Another random line.
How do you handle incidents?
"""
        path = tmp_path / "mixed.txt"
        path.write_text(content)
        questions = extract_questions(str(path), "txt")
        # Only the question lines should be extracted
        assert len(questions) == 2
        assert questions[0]["question_text"] == "What is your data retention policy?"


# ---------------------------------------------------------------------------
# Failure cases
# ---------------------------------------------------------------------------


class TestExtractUnsupportedFormat:
    """Test unsupported file format returns empty list."""

    def test_extract_unsupported_format(self, tmp_path):
        path = tmp_path / "file.xyz"
        path.write_text("some content")
        questions = extract_questions(str(path), "xyz")
        assert questions == []

    def test_extract_unknown_extension(self, tmp_path):
        path = tmp_path / "file.abc"
        path.write_text("What is your policy?")
        questions = extract_questions(str(path), "abc")
        assert questions == []


class TestExtractCorruptFile:
    """Test extraction from corrupt file returns empty list gracefully."""

    def test_extract_corrupt_docx(self, tmp_path):
        path = tmp_path / "corrupt.docx"
        path.write_bytes(b"not a real docx file content")
        questions = extract_questions(str(path), "docx")
        assert questions == []
