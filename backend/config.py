"""
Compliance Pilot — Configuration via environment variables.
"""

import ipaddress
import os
import socket
from urllib.parse import urlparse


def _csv_env(name: str, default: str) -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


class _Settings:
    # Deployment environment: "development" | "production"
    APP_ENV: str = os.getenv("APP_ENV", "development")

    # LLM Provider: "claude_code" (local CLI) or "ollama"
    LLM_PROVIDER: str = os.getenv("LLM_PROVIDER", "claude_code")

    OLLAMA_URL: str = os.getenv("OLLAMA_URL", "http://localhost:11434")
    LLM_MODEL: str = os.getenv("LLM_MODEL", "llama3.2")
    EMBED_MODEL: str = os.getenv("EMBED_MODEL", "mxbai-embed-large")
    EMBED_URL: str = os.getenv("EMBED_URL", "")  # Empty = use OLLAMA_URL

    CONFIDENCE_AUTO_FILL: float = float(os.getenv("CONFIDENCE_AUTO_FILL", "0.82"))
    CONFIDENCE_FLAG: float = float(os.getenv("CONFIDENCE_FLAG", "0.65"))
    MAX_CHUNKS: int = int(os.getenv("MAX_CHUNKS", "5"))
    HYBRID_ALPHA: float = float(os.getenv("HYBRID_ALPHA", "0.5"))
    MAX_CHUNK_CHARS: int = int(os.getenv("MAX_CHUNK_CHARS", "1000"))
    EMBED_CONCURRENCY: int = int(os.getenv("EMBED_CONCURRENCY", "1"))
    CHUNK_OVERLAP: int = int(os.getenv("CHUNK_OVERLAP", "150"))
    INGESTION_TIMEOUT: int = int(os.getenv("INGESTION_TIMEOUT", "600"))
    QUERY_EXPANSION_ENABLED: bool = os.getenv("QUERY_EXPANSION_ENABLED", "true").lower() == "true"
    RERANKING_ENABLED: bool = os.getenv("RERANKING_ENABLED", "true").lower() == "true"
    QDRANT_URL: str = os.getenv("QDRANT_URL", "http://localhost:6333")
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./compliance.db")

    # --- Auth / JWT ---
    JWT_SECRET: str = os.getenv("JWT_SECRET", "change-me-in-production")
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = int(os.getenv("JWT_EXPIRE_MINUTES", "480"))
    JWT_EXPIRY_HOURS: int = int(os.getenv("JWT_EXPIRY_HOURS", "8"))
    # Short-lived access token (cookie) + long-lived refresh token (cookie)
    ACCESS_TOKEN_MINUTES: int = int(os.getenv("ACCESS_TOKEN_MINUTES", "30"))
    REFRESH_TOKEN_DAYS: int = int(os.getenv("REFRESH_TOKEN_DAYS", "7"))

    # --- Cookies (httpOnly auth) ---
    COOKIE_SECURE: bool = os.getenv("COOKIE_SECURE", "false").lower() == "true"
    COOKIE_SAMESITE: str = os.getenv("COOKIE_SAMESITE", "lax")  # lax | strict | none

    # --- CORS ---
    CORS_ORIGINS: list[str] = _csv_env("CORS_ORIGINS", "http://localhost:5173")

    # --- Uploads ---
    MAX_UPLOAD_MB: int = int(os.getenv("MAX_UPLOAD_MB", "100"))

    # Optional base URL used to expand bare permalink slugs found in ingested
    # JSON KB articles into full links (e.g. "https://help.example.com/kb").
    # Empty = leave slugs as-is.
    KB_ARTICLE_URL_BASE: str = os.getenv("KB_ARTICLE_URL_BASE", "")

    # --- SSRF allowlist for admin-settable URLs (ollama/embed/qdrant) ---
    # Hosts here are always allowed; otherwise the host must resolve to a
    # loopback or private IP range. Comma-separated env override.
    SSRF_HOST_ALLOWLIST: list[str] = _csv_env(
        "SSRF_HOST_ALLOWLIST", "localhost,127.0.0.1,::1,host.docker.internal,qdrant,ollama"
    )

    DEFAULT_JWT_SECRET = "change-me-in-production"

    def validate(self) -> list[str]:
        """Validate config at startup. Returns warnings; raises on fatal
        problems when running in production."""
        warnings: list[str] = []

        # Confidence thresholds
        if not (0.0 <= self.CONFIDENCE_FLAG < self.CONFIDENCE_AUTO_FILL <= 1.0):
            raise ValueError(
                "Invalid confidence thresholds: require "
                "0 <= CONFIDENCE_FLAG < CONFIDENCE_AUTO_FILL <= 1 "
                f"(got flag={self.CONFIDENCE_FLAG}, auto_fill={self.CONFIDENCE_AUTO_FILL})"
            )
        if self.MAX_CHUNKS < 1:
            raise ValueError("MAX_CHUNKS must be >= 1")
        if self.EMBED_CONCURRENCY < 1:
            raise ValueError("EMBED_CONCURRENCY must be >= 1")
        if self.CHUNK_OVERLAP < 0:
            raise ValueError("CHUNK_OVERLAP must be >= 0")
        if self.INGESTION_TIMEOUT <= 0:
            raise ValueError("INGESTION_TIMEOUT must be > 0")

        # JWT secret
        weak_secret = (
            self.JWT_SECRET == self.DEFAULT_JWT_SECRET or len(self.JWT_SECRET) < 32
        )
        if weak_secret:
            msg = (
                "JWT_SECRET is the default or shorter than 32 chars. "
                "Set a strong secret, e.g. `export JWT_SECRET=$(openssl rand -hex 32)`."
            )
            if self.APP_ENV == "production":
                raise ValueError(f"Refusing to start in production: {msg}")
            warnings.append(msg)

        if self.APP_ENV == "production" and not self.COOKIE_SECURE:
            warnings.append(
                "COOKIE_SECURE is false in production — auth cookies will be sent over HTTP."
            )
        return warnings


settings = _Settings()


def is_internal_url(url: str) -> bool:
    """True if `url` is http(s) and points at an allowlisted host or a
    loopback/private IP. Used to prevent SSRF via admin-settable URLs."""
    if not url:
        return False
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = parsed.hostname
    if not host:
        return False
    if host in settings.SSRF_HOST_ALLOWLIST:
        return True
    # Resolve and require every address to be private/loopback.
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    addrs = {info[4][0] for info in infos}
    if not addrs:
        return False
    for addr in addrs:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False
        if not (ip.is_loopback or ip.is_private):
            return False
    return True
