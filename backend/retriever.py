"""
Compliance Pilot — RAG retriever: query Qdrant, generate answer via LLM.
Supports Claude Code CLI (local, no API key) and Ollama.
Hybrid search (dense + sparse), query expansion, re-ranking.
"""

import asyncio
import json
import re
import shutil
from typing import Dict, Any, List

import httpx
from qdrant_client import QdrantClient
from qdrant_client.models import (
    SparseVector, Prefetch, FusionQuery, Fusion,
)

from ingest import get_collection_name, get_embedding, get_sparse_embedding
from json_utils import extract_json


# ---------------------------------------------------------------------------
# System prompt — compliance-specific, structured
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert compliance assistant. Answer questions using ONLY the context passages below.

MOST IMPORTANT RULE — answer length must match question complexity:
- "Do you support X?" / "Is X available?" → 1-3 sentences ONLY. State yes/no and the key fact. STOP. No bullets.
- "What encryption/standard do you use?" → 1-3 sentences ONLY. State the fact. STOP. No bullets.
- "Describe..." / "List all..." / "Explain in detail..." → Full answer with bullet points as needed.
When in doubt, be SHORT. If 2 sentences suffice, write 2 sentences.

Other rules:
1. Use ONLY information from the context. Do not guess or fabricate. If insufficient, respond: NO_ANSWER_FOUND
2. Answer directly — no "Based on the provided context" preamble.
3. Plain text only — no **bold**, *italics*, `code`, or # headings. Do not include [Source: ...] citations in your answer.
4. If the context includes a [Reference URL], append it as "Reference: <URL>". Never fabricate URLs.
5. Passages labeled [APPROVED PRIOR ANSWER] contain previously approved responses. Use the "Our approved response" portion. Do not echo the question wording as policy."""


# ---------------------------------------------------------------------------
# Fallback prompt — used ONLY when the strict prompt returns NO_ANSWER_FOUND.
# Permits applying general capabilities/policies to a specific instance from
# the question, without relaxing the core "do not fabricate" rule. Answers
# produced via this path are always capped at `needs_review` confidence.
# ---------------------------------------------------------------------------

FALLBACK_SYSTEM_PROMPT = """A stricter reviewer marked this question NO_ANSWER_FOUND. Decide whether the context establishes a GENERAL capability that applies to the question's specific instance, even if the specific name is not mentioned.

## Rules
1. If a general capability clearly covers the specific instance, answer with "In general, " prefix.
2. Only generalize when the context is broadly stated ("any URL", "all users", "every endpoint"). Do not generalize when scoped narrowly to a different entity.
3. If unsupported, respond with exactly: NO_ANSWER_FOUND
4. Plain text only, 1-3 sentences for simple questions. Include Reference URL if available in context.

## Examples
Context: "All customer data is encrypted at rest using AES-256."
Q: "Is data in the analytics database encrypted?" → "In general, yes. All customer data is encrypted at rest using AES-256."

Context: "Data is encrypted in transit using TLS 1.2."
Q: "Are session tokens encrypted at rest?" → NO_ANSWER_FOUND (transit ≠ at rest)
"""


# ---------------------------------------------------------------------------
# Confidence tiers
# ---------------------------------------------------------------------------

# Soft-retry fallback answers are always capped below the auto-fill threshold
# (0.82 default) so they land in the `needs_review` tier and get a human eye.
SOFT_RETRY_CONFIDENCE_CAP = 0.70


def classify_confidence(score: float, auto_fill_threshold: float, flag_threshold: float) -> str:
    if score >= auto_fill_threshold:
        return "auto_fill"
    elif score >= flag_threshold:
        return "needs_review"
    else:
        return "no_answer"


# ---------------------------------------------------------------------------
# LLM Calls
# ---------------------------------------------------------------------------

async def _call_claude_code(prompt: str, system_prompt: str = SYSTEM_PROMPT) -> str:
    """Call Claude Code CLI installed on the machine. No API key needed."""
    full_prompt = f"{system_prompt}\n\n{prompt}"
    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", full_prompt, "--output-format", "text",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)

        if proc.returncode == 0:
            return stdout.decode("utf-8").strip()
        else:
            print(f"Claude Code CLI error (exit {proc.returncode}): {stderr.decode()}")
            return "NO_ANSWER_FOUND"
    except asyncio.TimeoutError:
        print("Claude Code CLI timed out")
        return "NO_ANSWER_FOUND"
    except FileNotFoundError:
        print("Claude Code CLI not found — is 'claude' in PATH?")
        return "NO_ANSWER_FOUND"
    except Exception as e:
        print(f"Claude Code CLI error: {e}")
        return "NO_ANSWER_FOUND"


def _no_proxy_client(timeout: float = 120.0) -> httpx.AsyncClient:
    """Bypass corporate proxy for local Ollama/Qdrant."""
    t = httpx.AsyncHTTPTransport()
    return httpx.AsyncClient(timeout=timeout, mounts={"http://localhost": t, "http://127.0.0.1": t})


async def _call_ollama(prompt: str, ollama_url: str, model: str,
                       system_prompt: str = SYSTEM_PROMPT) -> str:
    """Call Ollama LLM for generation."""
    try:
        async with _no_proxy_client(120.0) as client:
            resp = await client.post(
                f"{ollama_url}/api/generate",
                json={
                    "model": model,
                    "system": system_prompt,
                    "prompt": prompt,
                    "stream": False,
                },
            )
            resp.raise_for_status()
            return resp.json().get("response", "").strip()
    except Exception as e:
        print(f"Ollama error: {e}")
        return "NO_ANSWER_FOUND"


async def _call_llm(prompt: str, settings_dict: dict,
                    system_prompt: str = SYSTEM_PROMPT) -> str:
    """Route to the correct LLM provider based on settings."""
    provider = settings_dict.get("llm_provider", "claude_code")

    if provider == "claude_code":
        return await _call_claude_code(prompt, system_prompt=system_prompt)
    elif provider == "ollama":
        return await _call_ollama(
            prompt, settings_dict["ollama_url"], settings_dict["llm_model"],
            system_prompt=system_prompt,
        )
    else:
        return await _call_claude_code(prompt, system_prompt=system_prompt)


# ---------------------------------------------------------------------------
# Query expansion — generate alternative phrasings for broader recall
# ---------------------------------------------------------------------------

async def _expand_query(question: str, settings: dict) -> List[str]:
    """Generate 2-3 reformulations of the question for broader retrieval."""
    expansion_prompt = (
        "Given this compliance questionnaire question, generate exactly 3 alternative "
        "phrasings that capture the same intent but use different terminology. "
        "Return ONLY a JSON array of strings, no explanation.\n\n"
        f"Question: {question}\n\n"
        'Output format: ["rephrased 1", "rephrased 2", "rephrased 3"]'
    )
    try:
        response = await _call_llm(expansion_prompt, settings)
        if response and "NO_ANSWER_FOUND" not in response:
            expansions = extract_json(response, expect=list)
            if expansions and all(isinstance(e, str) for e in expansions):
                return [question] + expansions[:3]
            print(f"[EXPAND] No usable expansions parsed for: {question[:60]!r}")
    except Exception as e:
        print(f"[EXPAND] error: {e}")
    return [question]


# ---------------------------------------------------------------------------
# Re-ranking — LLM re-ranks retrieved chunks by relevance
# ---------------------------------------------------------------------------

async def _rerank_chunks(question: str, hits: list, top_k: int, settings: dict) -> list:
    """Use LLM to re-rank retrieved chunks by relevance to the question."""
    if len(hits) <= top_k:
        return hits

    chunk_summaries = []
    for i, hit in enumerate(hits):
        preview = hit.payload["text"][:200].replace("\n", " ")
        chunk_summaries.append(f"[{i}] {preview}")

    summaries_text = "\n".join(chunk_summaries)

    rerank_prompt = (
        f"Given this question and {len(hits)} text passages, rank the passages by relevance. "
        f"Return ONLY a JSON array of passage indices ordered from most to least relevant. "
        f"Return exactly {top_k} indices.\n\n"
        f"Question: {question}\n\n"
        f"Passages:\n{summaries_text}\n\n"
        f"Return ONLY a JSON array like [3, 0, 7, 1, ...] with {top_k} indices."
    )

    try:
        response = await _call_llm(rerank_prompt, settings)
        if response and "NO_ANSWER_FOUND" not in response:
            indices = extract_json(response, expect=list)
            if indices:
                reranked = []
                seen = set()
                for idx in indices:
                    if isinstance(idx, int) and 0 <= idx < len(hits) and idx not in seen:
                        reranked.append(hits[idx])
                        seen.add(idx)
                    if len(reranked) >= top_k:
                        break
                # Fill remaining with original order
                if len(reranked) < top_k:
                    for hit in hits:
                        if id(hit) not in {id(r) for r in reranked}:
                            reranked.append(hit)
                        if len(reranked) >= top_k:
                            break
                if reranked:
                    return reranked
            print(f"[RERANK] No usable ranking parsed; using original order")
    except Exception as e:
        print(f"[RERANK] error: {e}")
    return hits[:top_k]


# ---------------------------------------------------------------------------
# Hybrid search helper
# ---------------------------------------------------------------------------

def _search_hybrid(client: QdrantClient, collection_name: str,
                   dense_vec: list, sparse_vec: dict, limit: int) -> list:
    """Search Qdrant with both dense and sparse vectors using RRF fusion."""
    search_response = client.query_points(
        collection_name=collection_name,
        prefetch=[
            Prefetch(query=dense_vec, using="dense", limit=limit),
            Prefetch(
                query=SparseVector(
                    indices=sparse_vec["indices"],
                    values=sparse_vec["values"],
                ),
                using="sparse",
                limit=limit,
            ),
        ],
        query=FusionQuery(fusion=Fusion.RRF),
        limit=limit,
    )
    return search_response.points if search_response else []


def _search_dense_only(client: QdrantClient, collection_name: str,
                       dense_vec: list, limit: int) -> list:
    """Fallback: dense-only search for old collections without sparse vectors."""
    search_response = client.query_points(
        collection_name=collection_name,
        query=dense_vec,
        limit=limit,
    )
    return search_response.points if search_response else []


# ---------------------------------------------------------------------------
# Main query pipeline
# ---------------------------------------------------------------------------

async def query_knowledge_base(question: str, version: int, settings: dict) -> Dict[str, Any]:
    """
    Query the knowledge base and return an answer with confidence.
    Supports hybrid search, query expansion, and re-ranking.
    """
    embed_url = settings.get("embed_url") or settings["ollama_url"]
    embed_model = settings["embed_model"]
    qdrant_url = settings["qdrant_url"]
    max_chunks = settings.get("max_chunks", 5)
    auto_fill_threshold = settings.get("confidence_auto_fill", 0.82)
    flag_threshold = settings.get("confidence_flag", 0.65)
    query_expansion = settings.get("query_expansion_enabled", True)
    reranking = settings.get("reranking_enabled", True)

    no_answer_result = {
        "answer": "",
        "confidence_score": 0.0,
        "confidence_tier": "no_answer",
        "sources": [],
    }

    # Check collection exists
    collection_name = get_collection_name(version)
    client = QdrantClient(url=qdrant_url)
    if not client.collection_exists(collection_name):
        return no_answer_result

    # Detect if collection supports sparse vectors (v2+) or is dense-only (v1)
    collection_info = client.get_collection(collection_name)
    has_sparse = bool(getattr(collection_info.config.params, 'sparse_vectors', None))
    has_named_dense = isinstance(collection_info.config.params.vectors, dict)

    # Determine retrieval limit — over-fetch for re-ranking
    retrieval_limit = max_chunks * 2 if reranking else max_chunks

    # 1. Query expansion — generate alternative phrasings
    if query_expansion:
        queries = await _expand_query(question, settings)
    else:
        queries = [question]

    # 2. Search with each query variant, merge by best score
    all_results = {}  # point_id -> (hit, best_score)

    for q in queries:
        q_vector = await get_embedding(q, embed_url, embed_model)

        if has_sparse and has_named_dense:
            q_sparse = await get_sparse_embedding(q)
            hits = _search_hybrid(client, collection_name, q_vector, q_sparse, retrieval_limit)
        else:
            hits = _search_dense_only(client, collection_name, q_vector, retrieval_limit)

        for hit in hits:
            pid = hit.id
            if pid not in all_results or hit.score > all_results[pid][1]:
                all_results[pid] = (hit, hit.score)

    # Sort by score descending
    search_results = [h for h, s in sorted(all_results.values(), key=lambda x: -x[1])]

    if not search_results:
        return no_answer_result

    # 3. Re-rank if enabled
    if reranking and len(search_results) > max_chunks:
        search_results = await _rerank_chunks(question, search_results, max_chunks, settings)
    else:
        search_results = search_results[:max_chunks]

    # 4. Build context from search results
    context_parts = []
    sources = []
    scores = []

    for hit in search_results:
        payload = hit.payload
        source_line = f"[Source: {payload['source_file']}, Page {payload['page_number']}]"
        source_url = payload.get("source_url", "")
        if source_url:
            source_line += f" [Reference URL: {source_url}]"
        context_parts.append(f"{source_line}\n{payload['text']}")
        sources.append({
            "source_file": payload["source_file"],
            "source_url": payload.get("source_url", ""),
            "page_number": payload["page_number"],
            "section_title": payload.get("section_title", ""),
        })
        scores.append(hit.score)

    avg_score = sum(scores) / len(scores)
    top_score = max(scores)
    confidence_score = 0.6 * top_score + 0.4 * avg_score

    context = "\n\n---\n\n".join(context_parts)

    # 5. Generate answer via LLM
    prompt = (
        f"Context:\n{context}\n\n"
        f"Question: {question}\n\n"
        f"Answer:"
    )

    answer = await _call_llm(prompt, settings)

    # 6. Determine confidence — with soft-retry fallback on NO_ANSWER_FOUND
    if "NO_ANSWER_FOUND" in answer:
        # Soft-retry: same chunks, softer system prompt that allows generalizing
        # a broadly-stated capability to the question's specific instance.
        # Successful retries are ALWAYS capped at needs_review for human review.
        q_preview = question[:80].replace("\n", " ")
        print(f"[FALLBACK] Soft-retry triggered for: {q_preview}")

        fallback_answer = await _call_llm(
            prompt, settings, system_prompt=FALLBACK_SYSTEM_PROMPT
        )

        if fallback_answer and "NO_ANSWER_FOUND" not in fallback_answer:
            confidence_score = min(confidence_score, SOFT_RETRY_CONFIDENCE_CAP)
            confidence_tier = "needs_review"
            answer = fallback_answer
            print(
                f"[FALLBACK] Succeeded — tier=needs_review "
                f"score={round(confidence_score, 4)} cap={SOFT_RETRY_CONFIDENCE_CAP}"
            )
        else:
            confidence_score = 0.0
            confidence_tier = "no_answer"
            answer = ""
            print("[FALLBACK] Still no answer — returning no_answer")
    else:
        confidence_tier = classify_confidence(confidence_score, auto_fill_threshold, flag_threshold)

    return {
        "answer": answer,
        "confidence_score": round(confidence_score, 4),
        "confidence_tier": confidence_tier,
        "sources": sources,
    }
