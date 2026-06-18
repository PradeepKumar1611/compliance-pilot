#!/usr/bin/env python3
"""
Generate minimal test fixture files for Compliance Pilot UI tests.

Run once before executing UI tests:
    python3 tests/fixtures/create_fixtures.py
"""

import os
from zipfile import ZipFile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def create_sample_pdf():
    """Create a minimal valid PDF file."""
    pdf = (
        b"%PDF-1.4\n"
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
        b"3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj\n"
        b"xref\n0 4\n"
        b"0000000000 65535 f \n"
        b"0000000009 00000 n \n"
        b"0000000058 00000 n \n"
        b"0000000115 00000 n \n"
        b"trailer<</Size 4/Root 1 0 R>>\n"
        b"startxref\n206\n%%EOF"
    )
    path = os.path.join(SCRIPT_DIR, "sample_policy.pdf")
    with open(path, "wb") as f:
        f.write(pdf)
    print(f"Created {path}")


def create_sample_docx():
    """Create a minimal valid .docx with sample questionnaire questions."""
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        '  <Default Extension="xml" ContentType="application/xml"/>\n'
        '  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n'
        "</Types>"
    )

    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n'
        "</Relationships>"
    )

    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n'
        "  <w:body>\n"
        "    <w:p><w:r><w:t>Question 1: Does the organization have an information security policy?</w:t></w:r></w:p>\n"
        "    <w:p><w:r><w:t>Answer:</w:t></w:r></w:p>\n"
        "    <w:p><w:r><w:t>Question 2: How does the organization handle data breaches?</w:t></w:r></w:p>\n"
        "    <w:p><w:r><w:t>Answer:</w:t></w:r></w:p>\n"
        "    <w:p><w:r><w:t>Question 3: What encryption standards are used for data at rest?</w:t></w:r></w:p>\n"
        "    <w:p><w:r><w:t>Answer:</w:t></w:r></w:p>\n"
        "  </w:body>\n"
        "</w:document>"
    )

    path = os.path.join(SCRIPT_DIR, "sample_questionnaire.docx")
    with ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
    print(f"Created {path}")


if __name__ == "__main__":
    create_sample_pdf()
    create_sample_docx()
    print("Done. Fixture files are ready.")
