# Compliance Pilot Implementation Deep Dive

## Document Processing Technology Stack

### Why Multi-Format, Multi-Library Processing?

Compliance documents come in every format — vendor questionnaires in XLSX, security policies in PDF, internal procedures in DOCX, KB articles in JSON/HTML, and plain text exports. A single parser library cannot handle all formats equally well. Our strategy uses **format-specific parsers with intelligent fallbacks** to extract maximum content from every document type.

### Processing Libraries by Format

| Format | Primary Library | Fallback | Why This Choice |
|--------|----------------|----------|-----------------|
| **.docx** | **Docling** (AI-powered) | **python-docx** | Docling understands document layout, tables, and formatting natively and outputs clean markdown. python-docx is simpler but reliable for standard documents. |
| **.xlsx** | **Docling** | **openpyxl** | Docling handles complex spreadsheets with merged cells. openpyxl gives raw cell access for precise row/column targeting — critical for writing answers back to the correct cell. |
| **.pdf** | **Docling** | **PyMuPDF (fitz)** | Docling uses AI-based layout detection for complex PDFs. PyMuPDF provides fast text extraction and **form field access** (widgets) for fillable PDFs — no other library supports PDF form filling in Python as well. |
| **.json** | **Custom fuzzy parser** | — | No library exists for our use case. Our parser uses fuzzy key matching ("title"/"name"/"heading", "content"/"body"/"answer") to extract content from any JSON structure — vendor KB articles, API responses, custom formats. Preserves URL, author, tags, dates. |
| **.html** | **Custom HTMLParser** | — | Python's built-in HTMLParser stripped of script/style/nav tags. Preserves heading hierarchy (h1-h6 -> markdown #), links, table data. Lighter than BeautifulSoup, no extra dependency. |
| **.csv** | **Python csv** | — | Built-in CSV reader with header-aware formatting ("header: value" pairs). Simple, reliable, no dependencies. |
| **.txt/.md** | **Direct read** | — | Plain text and markdown are read as-is — no parsing needed, zero data loss. |

### The Docling Advantage

[Docling](https://github.com/DS4SD/docling) is an AI-powered document converter from IBM Research that understands document **layout and structure**, not just text. It's our primary parser for PDF/DOCX/XLSX because:

1. **Layout-aware**: Understands columns, sidebars, headers/footers — doesn't jumble multi-column text
2. **Table extraction**: Preserves table structure as markdown, including merged cells
3. **Native markdown output**: Returns clean markdown with proper headings — saves our markdown conversion step
4. **OCR support**: Can extract text from scanned PDFs via RapidOCR

When Docling fails (unsupported format, corrupted file), we fall back to format-specific libraries that are simpler but always work.

### Why Not Use a Single Library?

| Approach | Problem |
|----------|---------|
| **Docling only** | Doesn't handle JSON, HTML, CSV, TXT. Can fail on corrupted files. |
| **python-docx only** | Only handles DOCX. Can't read PDF or XLSX. |
| **PyMuPDF only** | Only handles PDF. No DOCX/XLSX support. |
| **LLM-based parsing** | Expensive (uses tokens), slow, unreliable for large documents, can hallucinate content. |
| **Our approach** | Best library per format + Docling as primary + Python fallbacks = handles everything, loses nothing. |

### Bidirectional Processing (Read + Write)

A unique advantage: we don't just **read** documents — we **write answers back** into the original format:

| Format | Read Library | Write Library | What's Preserved |
|--------|-------------|---------------|-----------------|
| **.docx** | Docling / python-docx | **python-docx** | Original formatting, styles, images, tables — only answer cells modified |
| **.xlsx** | Docling / openpyxl | **openpyxl** | All sheets, formulas, formatting — only answer column filled, text wrapped |
| **.pdf** (fillable) | PyMuPDF | **PyMuPDF** | Form fields filled with answers + footer annotation |
| **.pdf** (non-fillable) | PyMuPDF | **python-docx** (generates new DOCX) | Original questions preserved in Q&A table |
| **.json** | Custom parser | **json** | Structured output with all metadata |

This means: **you upload a 50-question XLSX questionnaire, and get back the SAME XLSX with column B filled** — not a separate text file. The original document structure, formatting, and formulas are preserved.

### How This Benefits Compliance Teams

1. **Zero manual formatting**: Answers go directly into the questionnaire cells — no copy-paste from a chat window
2. **Auditor-friendly**: The filled document looks professional, with confidence markers and source citations
3. **Multi-format support**: Teams receive questionnaires in different formats from different vendors — all handled automatically
4. **Section context**: Questions under "Network Security" are searched differently from questions under "Data Privacy" — same question text, different answers
5. **Preservation**: Original document formatting, company logos, headers — all preserved. Only answer fields are modified
6. **Traceability**: Every answer includes `[Source: filename, p.N]` — auditors can verify against the original policy

---

## 1. Knowledge Base Creation Pipeline

### Overview
```
Upload (.pdf/.docx/.xlsx/.txt/.json/.html/.csv/.zip)
  --> Parse to raw text
  --> Convert to clean Markdown
  --> Smart chunk by sections (with overlap)
  --> Embed (dense + sparse)
  --> Store in Qdrant collection
```

### Step 1: File Parsing (`ingest.py: _parse_to_text()`)

Each file format has a dedicated parser that extracts maximum content:

| Format | Parser | What's Preserved |
|--------|--------|-----------------|
| **.json** | Custom fuzzy-key parser | Title, URL, author, category, tags, dates, summary, content. Recurses into nested dicts. |
| **.txt** | Direct file read | Everything — metadata headers (URL, Author, Tags) included |
| **.html** | Custom HTMLParser | Headings (h1-h6 -> #), paragraphs, links, table data. Strips script/style/nav. Extracts `<title>`. |
| **.csv** | Python csv module | Headers as "## Columns:", rows as "header: value" pairs |
| **.docx** | Docling (primary), python-docx (fallback) | Paragraphs, heading styles converted to markdown `#` |
| **.pdf** | Docling (primary), PyMuPDF (fallback) | Page text with `## Page N` headers |
| **.xlsx** | Docling (primary), openpyxl (fallback) | All sheets, rows as pipe-separated values with `## SheetName` headers |
| **.zip** | Python zipfile | Extracts all supported files, skips `__MACOSX`, `._*`, `.DS_Store` |

**JSON Parser Detail** — The most sophisticated parser. Uses fuzzy key matching to find content in any JSON structure:
```
1. Find "title" (or "name", "heading", "subject") -> # heading
2. Find "webUrl" (or "url", "link", "permalink") -> URL: line
3. Find "author" (string or dict with "name") -> Author: line
4. Find "category" (string or dict with "name") -> Category: line
5. Find "tags" (array or string) -> Tags: comma-separated
6. Find "createdTime" / "modifiedTime" -> Created: / Modified: lines
7. Find "summary" -> summary paragraph
8. Find "content" (or "body", "text", "answer") -> main content
9. Fallback: any string field > 10 chars, recurse into nested dicts
```

### Key Parser Functions (ingest.py)
- `_parse_to_text(file_path)` — Routes by file extension to format-specific parser
- `_parse_json(file_path)` — Fuzzy key matching for title, URL, author, tags, content, with nested dict recursion
- `_parse_html(file_path)` — Custom HTMLParser, strips script/style, preserves headings/links/tables, extracts `<title>`
- `_parse_csv(file_path)` — Header-aware "header: value" pairs per row
- `_parse_docx(file_path)` — python-docx paragraph extraction with heading style detection
- `_parse_pdf(file_path)` — PyMuPDF page text with `## Page N` headers
- `_parse_xlsx(file_path)` — openpyxl all-sheets iteration with pipe-separated rows
- **Docling fallback**: For PDF/DOCX/XLSX, Docling is tried first (outputs markdown natively), with above parsers as fallback

### Step 2: Markdown Conversion (`ingest.py: _convert_to_markdown()`)

Python string processing (no LLM) — deterministic and fast:
- Strips HTML tags (`<.*?>`)
- Normalizes whitespace
- Adds `# Title` from filename if no heading exists
- Preserves all content — zero data loss

### Step 3: Smart Chunking (`ingest.py: chunk_document()`)

Section-aware splitting that respects document structure:

```
1. Split by markdown headings (#{1,4}) and horizontal rules (---)
2. For each section:
   a. Extract section_title from heading
   b. If section <= MAX_CHUNK_CHARS (1000): one chunk
   c. If too long: split by paragraphs
   d. If paragraph too long: split by sentences
   e. If sentence too long: split by words
3. Apply overlap: prepend last 150 chars from previous chunk
```

**Chunk Metadata**:
- `text`: The chunk content
- `source_file`: Original filename
- `page_number`: Page (for PDFs) or 1
- `section_title`: Heading text
- `chunk_index`: Sequential index
- `ingested_at`: ISO timestamp

**Overlap**: Each chunk (except the first) starts with `...{last 150 chars of previous chunk}` — ensures no context is lost at boundaries.

### Step 4: Embedding (`ingest.py: ingest_document()`)

**Context-Enriched Embedding**: Before embedding, each chunk is prepended with document and section context:
```
"Document: Data Retention Policy | Section: Cloud Storage\n\n{actual chunk text}"
```
This prefix is ONLY used for embedding — the stored payload keeps the original text (saves LLM context window).

**Dense Embedding** (`get_embedding(text, ollama_url, model)`): Ollama model (qwen3-embedding:4b, 2560 dims, or configurable)
- Retry: 3 attempts with 1s, 2s backoff
- Proxy bypass: `_no_proxy_client()` with httpx mounts

**Sparse Embedding** (`get_sparse_embedding(text)`): BM42 via fastembed
- Runs in thread pool (`asyncio.to_thread`) to avoid GIL blocking
- Produces indices + values for keyword matching
- Model cached globally (`_sparse_model` singleton)

**Auto-Detection** (`detect_embedding_dims(ollama_url, model)`): Runs a test embedding to detect vector dimensions from the model — no hardcoded sizes

**Concurrency**: Configurable `embed_concurrency` (default 1 for 16GB, up to 16 for 256GB+)
- Uses `asyncio.Semaphore` for controlled parallelism

### Step 5: Qdrant Storage

Each KB version gets its own collection: `policy_v{version}`

**Collection Configuration**:
```python
vectors_config = {"dense": VectorParams(size=auto_detected, distance=COSINE)}
sparse_vectors_config = {"sparse": SparseVectorParams()}
```

**Point Structure**:
```python
PointStruct(
    id=UUID,
    vector={
        "dense": [0.23, -0.87, ...],  # 2560 dims (qwen3-4b)
        "sparse": SparseVector(indices=[3, 17, 42], values=[0.8, 0.5, 0.3])
    },
    payload={
        "text": "actual chunk content",
        "source_file": "data-retention.json",
        "source_url": "https://help.example.com/kb/article-slug
        "page_number": 1,
        "section_title": "Data Retention",
        "chunk_index": 0,
        "version": 4,
        "ingested_at": "2026-04-05T..."
    }
)
```

### Background Processing

All ingestion runs in an isolated thread to keep the HTTP server responsive:
```
_retry_batch() [async, main event loop]
  --> asyncio.to_thread(_sync_batch) [separate thread]
    --> new event loop per thread
    --> for each document:
        --> timeout: configurable (default 600s)
        --> 2 retry attempts
        --> GIL-releasing sleep(0.1) between docs
    --> progress tracked in global dict
    --> cancellable via _cancel_ingestion flag
```

---

## 2. Process Questionnaire Pipeline

### Overview
```
Upload questionnaire (.docx/.xlsx/.pdf/.txt/.json)
  --> Extract questions (LLM + heuristic)
  --> For each question:
      --> Detect language, translate if needed
      --> Add section context
      --> Search KB (hybrid + expansion + re-ranking)
      --> Generate answer (LLM)
      --> Clean answer (LLM)
      --> Translate back if needed
      --> Log to audit
  --> Fill answers into original document
  --> Return filled document for download
```

### Step 1: Question Extraction (`extractor.py`)

**Two-stage approach**:
1. **LLM extraction** (`extract_questions_smart`): Sends full document text to LLM, asks it to identify questions
2. **Heuristic fallback** (`extract_questions`): Pattern-based detection

**LLM-Heuristic Location Matching**: When LLM extracts questions (possibly rephrased), we match them back to heuristic-detected locations to preserve correct row/cell positions. Uses `heuristic_used` tracking to handle duplicate question texts.

**Section Context Detection** (`section_context` field in each extracted question):
- **XLSX**: Bold cells or short non-instructional text become section headings. Sheet names as initial context. Filters out "If yes...", "Please..." as non-headings.
- **DOCX**: Heading-style paragraphs (`Heading 1`, `Heading 2`, etc.) tracked via `para_sections` map
- **TXT**: Short lines (< 100 chars) that aren't questions
- **Usage**: Section context prepended to search query: `"[Data Encryption] How do you store passwords?"`

**Multi-Sheet XLSX Support**: Iterates ALL worksheets, not just the active one. Each question's `location_info` includes the sheet name.

### Step 2: Knowledge Base Query (`retriever.py: query_knowledge_base()`)

### Key Retrieval Functions (retriever.py)
- `query_knowledge_base(question, version, settings)` — Main RAG pipeline
- `_expand_query(question, settings)` — LLM generates 3 reformulations
- `_rerank_chunks(question, hits, top_k, settings)` — LLM re-orders chunks by relevance
- `_search_hybrid(client, collection, dense_vec, sparse_vec, limit)` — RRF fusion search
- `_search_dense_only(client, collection, dense_vec, limit)` — Fallback for v1 collections
- `_call_claude_code(prompt)` — Claude Code CLI subprocess
- `_call_ollama(prompt, url, model)` — Ollama HTTP API
- `_call_llm(prompt, settings)` — Routes to configured provider

**2a. Query Expansion** (`_expand_query`, if enabled):
```
Original: "How do you store passwords?"
Expanded: [
  "How do you store passwords?",
  "What password storage mechanisms are used?",
  "Describe the password management and hashing approach",
  "What security measures protect stored credentials?"
]
```

**2b. Hybrid Search** (per query variant):
```python
client.query_points(
    prefetch=[
        Prefetch(query=dense_vector, using="dense", limit=N),
        Prefetch(query=sparse_vector, using="sparse", limit=N),
    ],
    query=FusionQuery(fusion=Fusion.RRF),  # Reciprocal Rank Fusion
    limit=N,
)
```
Results from all variants merged by best score per point.

**2c. Re-ranking** (if enabled):
- Over-fetch 2x chunks
- LLM re-ranks by relevance to original question
- Take top-k after re-ranking

**2d. Answer Generation**:
```
System: Expert compliance assistant, cite policy language, NO_ANSWER_FOUND if unsure
Context: [Source: file.json, Page 1]\n{chunk text}\n---\n[Source: ...]
Question: {question}
Answer: {LLM generates}
```

**2e. Confidence Scoring**:
```python
confidence = 0.6 * top_hit_score + 0.4 * average_score
```
- `>= 0.60`: auto_fill (green)
- `0.60 - 0.60`: needs_review (currently same thresholds)
- `< 0.60`: no_answer (red)

### Step 3: Answer Post-Processing

**LLM Cleanup** (`llm_skills.py: clean_answer_with_llm()`):
- Removes "Based on the provided context..." boilerplate
- Keeps facts, standards, numbers
- Uses bullet points for lists
- Limits to ~200 words

**Translation**: If original question was non-English, answer is translated back to the original language.

### Step 4: Document Filling (`filler.py`)

### Key Filler Functions (filler.py)
- `fill_document(file_path, file_type, qa_pairs, version)` — Main router by format
- `_fill_docx(file_path, qa_pairs, version)` — Table cell filling + paragraph insertion with colored text
- `_fill_xlsx(file_path, qa_pairs, version)` — Multi-sheet cell filling, text wrap, column width
- `_fill_pdf(file_path, qa_pairs, version)` — Form field filling (fillable) or DOCX fallback (non-fillable)
- `_fill_json(file_path, qa_pairs, version)` — Structured JSON results
- `_fill_txt_as_docx(file_path, qa_pairs, version)` — New DOCX with Q&A table
- `_format_answer(qa)` — Formats answer text with confidence markers and source citations
- `_fuzzy_field_match(field_name, label, question)` — PDF form field matching

### Translation Functions (translator.py)
- `detect_language(text)` — Uses langdetect library, returns ISO 639-1 code
- `translate_to_english(text, lang, ...)` — Translates non-English questions before KB search
- `translate_from_english(text, lang, ...)` — Translates answers back to original language

### Job Management (job_manager.py)
- `create_job(db, user_id, filename)` — Creates ProcessingJob, returns job_id
- `update_job_status(db, job_id, status, ...)` — Updates progress, error, completion time
- `get_job(db, job_id)` — Fetch single job
- `get_user_jobs(db, user_id)` — Fetch all jobs for user (ordered by created_at DESC)

| Input Format | Output Format | How Answers Are Inserted |
|-------------|---------------|-------------------------|
| .docx | .docx | Table cells filled + paragraph insertion (colored, italic) |
| .xlsx | .xlsx | Column B cells, text wrapped, 80-char width, all sheets |
| .pdf (fillable) | .pdf | Form field values set via PyMuPDF widgets |
| .pdf (non-fillable) | .docx | New DOCX with Q&A table generated |
| .txt | .docx | New DOCX with Q&A table generated |
| .json | .json | Structured JSON with results array |

**Confidence Markers in Documents**:
- **auto_fill**: Green italic answer + `[Source: filename, p.N]`
- **needs_review**: Orange italic `Warning: Needs Review: {answer}`
- **no_answer**: Red italic `No confident answer found - human review required`

---

## 3. Chat System

### Conversation Memory
```
User: "What encryption do you use?"
Assistant: "AES-256 for data at rest..."

User: "What key management?"  (ambiguous without context)
  --> LLM rewrites: "What key management system is used for AES-256 encryption?"
  --> Searches KB with the self-contained question
```

The last 6 messages (3 exchanges) are sent with each request. The LLM rewrites ambiguous follow-up questions to be self-contained before KB search.

### Persistent Messages
Messages are stored in a module-level variable (`_persistedMessages`) outside the React component, so they survive navigation between tabs. A "Clear Chat" button resets the conversation.

---

## 4. URL Validator

### How It Works
```
1. User selects KB version + clicks "Check URLs"
2. Backend scrolls through ALL Qdrant points in that collection
3. Regex extracts URLs from chunk text: https?://[^\s<>"')\]},]+
4. Deduplicates URLs, maps each to source files
5. Checks each URL (5 concurrent):
   a. HEAD request first (fast)
   b. If HEAD >= 400: retry with GET (many servers reject HEAD)
   c. If GET >= 400: retry once after 1s delay (rate limiting)
   d. Browser-like User-Agent header (avoids bot detection)
6. Reports down URLs with HTTP status + source file names
```

### Rate Limiting Protection
- Concurrency reduced to 5 (was 20) to avoid triggering rate limits
- 1-second retry delay for transient failures
- Browser User-Agent header

---

## 5. Ingestion Management

### Version System
Each KB version is a separate Qdrant collection (`policy_v{N}`) with its own metadata:
- **Name**: Human-readable (e.g., "Full Training Data")
- **Embed Model**: Which model was used (e.g., "qwen3-embedding:4b")
- **Doc Count**: Number of ready documents
- **Active Flag**: Which version is used for queries

### Backup & Restore
- **Backup**: Creates Qdrant snapshot -> downloads to `backups/` folder (< 1 second)
- **Restore**: Uploads snapshot -> recreates collection (< 1 second)
- **Auto-backup**: Before any version delete, a backup is automatically created

### Ingestion Status Panel
Real-time progress tracking during batch ingestion:
- Current document name
- Processed / Total count
- Progress bar
- Cancel button
- Auto-refresh when complete

### Thread Isolation
All batch processing runs in `asyncio.to_thread()` with a separate event loop. This prevents:
- GIL blocking from CPU-bound sparse embeddings (fastembed)
- Event loop starvation from continuous embedding calls
- HTTP handler stalls during long ingestion runs

### Corporate Proxy Bypass
The backend clears proxy environment variables at startup and uses custom httpx clients with explicit transport mounts for localhost connections:
```python
def _no_proxy_client(timeout):
    transport = httpx.AsyncHTTPTransport()
    return httpx.AsyncClient(
        timeout=timeout,
        mounts={"http://localhost": transport, "http://127.0.0.1": transport}
    )
```

---

## 6. All Configurable Settings

| Setting | Default | UI Location | Description |
|---------|---------|-------------|-------------|
| LLM Provider | claude_code | Settings > System Config | Claude Code CLI or Ollama |
| Ollama URL | localhost:11434 | Settings > Ollama Config | LLM service endpoint |
| LLM Model | llama3.2 | Settings > Ollama Config | LLM model name |
| Embedding Service URL | (empty = Ollama URL) | Settings > KB Ingestion | Separate embedding endpoint |
| Embedding Model | qwen3-embedding:4b | Settings > KB Ingestion | Dropdown + custom input |
| Max Chunk Size | 1000 chars | Settings > KB Ingestion | Per-chunk character limit |
| Parallel Embeddings | 1 | Settings > KB Ingestion | Concurrent embedding calls |
| Chunk Overlap | 150 chars | Settings > KB Ingestion | Overlap between chunks |
| Per-doc Timeout | 600s | Settings > KB Ingestion | Ingestion timeout per document |
| Max Chunks per Question | 8 | Settings > Retrieval | Context chunks to retrieve |
| Auto-fill Threshold | 0.60 | Settings > Retrieval | Confidence for auto-fill |
| Flagging Threshold | 0.60 | Settings > Retrieval | Confidence for needs-review |
| Hybrid Search | RRF (fixed) | Settings > Retrieval | Dense + Sparse fusion method |
| Query Expansion | On | Settings > Retrieval | Toggle LLM query reformulation |
| Re-ranking | On | Settings > Retrieval | Toggle LLM chunk re-ranking |

---

## 7. API Endpoints Reference

### Authentication
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/login | None | Login, returns JWT |
| POST | /api/auth/change-password | User | Change own password |
| GET | /api/auth/me | User | Current user info |

### User Management
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/users | Admin | List users |
| POST | /api/users | Admin | Create user |
| PUT | /api/users/{id}/role | Admin | Change role |
| POST | /api/users/{id}/reset-password | Admin | Reset password |
| DELETE | /api/users/{id} | Admin | Delete user |

### Knowledge Base
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/kb/version | User | Get active version |
| GET | /api/kb/versions | User | List all versions with metadata |
| POST | /api/kb/version | Admin | Create new version |
| PUT | /api/kb/versions/{id}/name | Admin | Rename version |
| POST | /api/kb/versions/{id}/activate | Admin | Set active version |
| DELETE | /api/kb/version/{id} | Admin | Delete version (auto-backup) |
| POST | /api/kb/upload | Admin | Upload document(s) |
| GET | /api/kb/documents | User | List documents (paginated, filterable) |
| DELETE | /api/kb/documents/{id} | Admin | Delete single document |
| POST | /api/kb/retry-failed | Admin | Retry failed docs |
| POST | /api/kb/reingest-all | Admin | Re-ingest into new version |
| GET | /api/kb/ingestion-status | User | Batch progress |
| POST | /api/kb/cancel-ingestion | Admin | Cancel batch |
| DELETE | /api/kb/clear-all | Admin | Delete everything |
| POST | /api/kb/backup/{id} | Admin | Create snapshot |
| GET | /api/kb/backups | Admin | List backups |
| POST | /api/kb/restore/{file} | Admin | Restore from snapshot |
| POST | /api/kb/validate-urls | Admin | Check KB URLs |
| GET | /api/kb/url-validation-status | User | URL check progress |

### Questionnaire Processing
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/questionnaire/upload | User | Upload & process |
| GET | /api/questionnaire/jobs | User | List jobs |
| GET | /api/questionnaire/jobs/{id} | User | Job status |
| POST | /api/questionnaire/jobs/{id}/cancel | User | Cancel job |
| GET | /api/questionnaire/jobs/{id}/download | User | Download filled doc |
| GET | /api/questionnaire/jobs/{id}/results | User | Q&A results |

### Chat, Audit, Dashboard, Settings
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/chat | User | Ask KB question with conversation memory |
| GET | /api/audit | User | Paginated audit logs with filters |
| GET | /api/audit/{id} | User | Single log detail |
| GET | /api/audit/export/csv | Admin | CSV export |
| GET | /api/dashboard/stats | User | Summary stats |
| GET | /api/dashboard/recent-audit | User | Last 10 entries |
| GET | /api/dashboard/active-jobs | User | Running jobs |
| GET | /api/settings | Admin | All settings |
| PUT | /api/settings | Admin | Update settings |
| POST | /api/settings/test-connection | Admin | Test LLM/embedding |
| GET | /api/health | None | Health check |
