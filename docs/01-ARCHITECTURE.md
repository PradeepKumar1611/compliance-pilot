# Compliance Pilot Architecture

## Overview

Compliance Pilot is a web application that automates compliance questionnaire answering. Admins upload policy documents into a knowledge base. When users upload compliance questionnaires, the system reads every question, searches the KB for relevant answers, generates responses using an LLM, and fills them back into the original document for download.

## System Architecture

```
                                    +------------------+
                                    |   User Browser   |
                                    |  (localhost:5173) |
                                    +--------+---------+
                                             |
                                     Vite Proxy /api
                                             |
+---------------------------+       +--------v---------+       +-------------------+
|      Ollama (LLM)         |<----->|    FastAPI        |<----->|     Qdrant        |
| localhost:11434           |       |    Backend         |       |  (Vector DB)      |
|                           |       |  localhost:9000    |       | localhost:6333    |
| Models:                   |       |                    |       |                   |
| - qwen3-embedding:4b     |       | - Auth (JWT)       |       | Collections:      |
|   (embeddings)            |       | - Ingestion        |       | - policy_v2       |
| - llama3.2:3b            |       | - Retrieval (RAG)  |       | - policy_v3       |
|   (optional LLM)         |       | - Processing       |       | - policy_v4       |
|                           |       | - Audit Logging    |       |                   |
+---------------------------+       +--------+---------+       +-------------------+
                                             |
                              OR             |
                                             |
+---------------------------+       +--------v---------+
|   Claude Code CLI         |       |     SQLite DB     |
| (Primary LLM Provider)   |       |  compliance.db    |
|                           |       |                   |
| No API key needed         |       | Tables:           |
| Local subprocess          |       | - users           |
+---------------------------+       | - kb_documents    |
                                    | - kb_versions     |
+---------------------------+       | - processing_jobs |
|   Remote Ollama (Mac)     |       | - audit_logs      |
| 10.89.28.194:11434       |       | - settings        |
| (Optional GPU embedding)  |       +-------------------+
+---------------------------+

+---------------------------+
|   Frontend (React 18)     |
| Vite + Tailwind CSS       |
|                           |
| Pages:                    |
| - Dashboard               |
| - Knowledge Base           |
| - Process Questionnaire    |
| - Chat                     |
| - Audit Log                |
| - URL Validator             |
| - Settings                  |
+---------------------------+
```

## Service Connectivity

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| Frontend (Vite) | 5173 | HTTP | React dev server, proxies /api to backend |
| Backend (FastAPI) | 9000 | HTTP | All API endpoints, background processing |
| Qdrant (Docker) | 6333 | HTTP | Vector database for KB embeddings |
| Ollama (Local) | 11434 | HTTP | Embedding model + optional LLM |
| Ollama (Remote) | 11434 | HTTP | GPU-accelerated embeddings (configurable) |
| SQLite | File | — | Metadata, users, audit logs, settings |

## Technology Stack

### Backend
| Technology | Purpose | Version |
|-----------|---------|---------|
| Python | Runtime | 3.10+ |
| FastAPI | Web framework (async) | Latest |
| SQLAlchemy | ORM (async with aiosqlite) | 2.0+ |
| SQLite | Metadata database | Built-in |
| Qdrant | Vector database (hybrid dense+sparse) | 1.17.1 (Docker) |
| httpx | Async HTTP client | 0.27.2 |
| fastembed | BM42 sparse embeddings for hybrid search | Latest |
| bcrypt | Password hashing | Latest |
| PyJWT | JSON Web Tokens | Latest |
| langdetect | Language detection for multilingual support | Latest |

### Document Processing Libraries
| Library | Formats | Read | Write | Why |
|---------|---------|:----:|:-----:|-----|
| **Docling** (IBM Research) | PDF, DOCX, XLSX | Yes | — | AI-powered layout detection, native markdown output, table extraction, OCR |
| **PyMuPDF (fitz)** | PDF | Yes | Yes | Fast text extraction + **PDF form field filling** (widgets) — unique capability |
| **python-docx** | DOCX | Yes | Yes | Reliable paragraph/table access, preserves formatting when filling answers |
| **openpyxl** | XLSX | Yes | Yes | Multi-sheet support, cell formatting, text wrapping for filled answers |
| **Custom HTMLParser** | HTML | Yes | — | Lightweight, preserves heading hierarchy, extracts links, no extra dependency |
| **Custom JSON parser** | JSON | Yes | Yes | Fuzzy key matching for any JSON structure, preserves URL/author/tags metadata |
| **Python csv** | CSV | Yes | — | Header-aware row parsing, built-in |

**Strategy**: Docling is the primary parser for PDF/DOCX/XLSX (best quality). Format-specific libraries serve as fallbacks and are used for **writing answers back** into the original document format.

### Frontend
| Technology | Purpose |
|-----------|---------|
| React 18 | UI framework |
| Tailwind CSS | Styling |
| React Router | Client-side routing |
| Axios | HTTP client with interceptors |
| Lucide React | Icon library |
| Vite | Build tool & dev server |

### AI/ML Models
| Model | Type | Params | Dims | Purpose |
|-------|------|--------|------|---------|
| qwen3-embedding:4b | Embedding | 4B | 2560 | Document & query embeddings (primary) |
| mxbai-embed-large | Embedding | 335M | 1024 | Alternative embedding model |
| BM42 (fastembed) | Sparse | — | — | Keyword-based sparse vectors |
| Claude Code CLI | LLM | — | — | Answer generation (primary) |
| llama3.2:3b | LLM | 3.2B | — | Alternative LLM (Ollama) |

## Database Schema

### users
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| username | VARCHAR(100) UNIQUE | Login name |
| hashed_password | VARCHAR(255) | bcrypt hash |
| role | VARCHAR(20) | "admin" or "user" |
| must_change_password | BOOLEAN | Force password change on login |
| created_at | DATETIME | Account creation time |

### kb_documents
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| filename | VARCHAR(255) | Original file name |
| version | INTEGER | KB version this doc belongs to |
| chunk_count | INTEGER | Number of chunks created |
| status | VARCHAR(20) | "processing", "ready", "failed" |
| error_message | TEXT | Failure reason (if failed) |
| file_path | VARCHAR(500) | Path to uploaded file on disk |
| ingested_at | DATETIME | Ingestion timestamp |

### kb_versions
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| version | INTEGER UNIQUE | Version number |
| name | VARCHAR(255) | Human-readable name |
| embed_model | VARCHAR(100) | Embedding model used |
| doc_count | INTEGER | Number of ready documents |
| is_active | BOOLEAN | Active version for queries |
| created_at | DATETIME | Version creation time |

### processing_jobs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| user_id | INTEGER FK | Who submitted the job |
| filename | VARCHAR(255) | Questionnaire filename |
| status | VARCHAR(20) | "queued", "processing", "done", "failed", "cancelled" |
| total_questions | INTEGER | Questions detected |
| processed_questions | INTEGER | Questions answered so far |
| output_file_path | VARCHAR(500) | Path to filled document |
| error_message | TEXT | Failure reason |
| created_at | DATETIME | Job submission time |
| completed_at | DATETIME | Job completion time |

### audit_logs
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| question_text | TEXT | The question asked |
| answer_text | TEXT | Generated answer |
| confidence_score | FLOAT | 0.0 to 1.0 |
| confidence_tier | VARCHAR(20) | "auto_fill", "needs_review", "no_answer" |
| kb_version_used | INTEGER | Which KB version was queried |
| llm_model_used | VARCHAR(100) | Which LLM generated the answer |
| source_citations | TEXT (JSON) | Array of source file/page references |
| was_translated | BOOLEAN | Whether question was translated |
| original_language | VARCHAR(10) | ISO 639-1 language code |
| processing_job_id | INTEGER FK | Which questionnaire job |
| user_id | INTEGER FK | Who initiated the query |
| timestamp | DATETIME | When the answer was generated |

### settings
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| key | VARCHAR(100) UNIQUE | Setting name |
| value | TEXT | Setting value (string) |
| updated_at | DATETIME | Last modified |

## File System Layout

```
compliance-pilot/
+-- backend/                 # FastAPI backend
|   +-- main.py              # All API routes, startup, background tasks
|   +-- models.py            # SQLAlchemy models
|   +-- config.py            # Environment variable defaults
|   +-- ingest.py            # KB ingestion pipeline
|   +-- retriever.py         # RAG retrieval + answer generation
|   +-- extractor.py         # Question extraction from documents
|   +-- filler.py            # Answer filling into documents
|   +-- translator.py        # Language detection & translation
|   +-- llm_skills.py        # LLM helper functions
|   +-- auth.py              # JWT authentication
|   +-- job_manager.py       # Processing job tracking
|   +-- audit_logger.py      # Audit log management
|   +-- compliance.db        # SQLite database
|   +-- requirements.txt     # Python dependencies
+-- frontend/                # React frontend
|   +-- src/
|   |   +-- pages/           # Dashboard, KnowledgeBase, Process, Chat, AuditLog, UrlValidator, Settings, Login
|   |   +-- components/      # Layout, Toast
|   |   +-- lib/             # api.js, utils.js
|   +-- package.json
+-- uploads/                 # Uploaded files (KB docs + questionnaires)
+-- outputs/                 # Generated filled documents
+-- backups/                 # Qdrant collection snapshots
+-- qdrant_storage/          # Qdrant persistent data (Docker volume)
+-- docker-compose.yml       # Qdrant service definition
+-- tests/
|   +-- backend/             # pytest unit tests (93 tests)
|   +-- ui/                  # Playwright E2E tests
+-- docs/                    # This documentation
```

## Authentication Flow

```
1. POST /api/auth/login { username, password }
   +-- bcrypt verify password
   +-- Return JWT token (8h expiry)

2. All subsequent requests:
   +-- Authorization: Bearer <token>
   +-- Frontend interceptor adds token automatically
   +-- 401 response -> redirect to /login

3. Role-based access:
   +-- Admin: All pages + settings + KB management + user management
   +-- User: Dashboard, Process, Chat, Audit Log, Settings (password only)
```

## Startup Sequence

```
1. FastAPI app created
2. Proxy env vars cleared (corporate proxy bypass)
3. BM42 sparse model pre-loaded (fastembed)
4. SQLAlchemy engine created
5. init_db():
   a. Create all tables (if not exist)
   b. Seed default admin (admin/admin123)
   c. Migrate kb_versions from existing data
6. Uvicorn serves on port 9000
```
