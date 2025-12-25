from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Azure OpenAI (preferred)
    AZURE_OPENAI_API_KEY: str = ""
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_VERSION: str = "2025-04-01-preview"
    AZURE_OPENAI_DEPLOYMENT_CHAT: str = ""
    AZURE_OPENAI_DEPLOYMENT_SUGGEST: str = ""
    AZURE_OPENAI_REALTIME_MODEL: str = ""
    AZURE_OPENAI_REALTIME_SESSIONS_URL: str = ""
    AZURE_OPENAI_REALTIME_WEBRTC_URL: str = ""

    # OpenAI (fallback / prototype)
    OPENAI_API_KEY: str = ""
    OPENAI_REALTIME_MODEL: str = "gpt-4o-realtime-preview-2024-12-17"
    OPENAI_REALTIME_SESSION_URL: str = "https://api.openai.com/v1/realtime/sessions"
    OPENAI_REALTIME_WEBRTC_URL: str = "https://api.openai.com/v1/realtime"
    OPENAI_SUGGEST_MODEL: str = "gpt-5-nano"
    OPENAI_CHAT_MODEL: str = "gpt-5-nano"
    OPENAI_RESPONSES_URL: str = "https://api.openai.com/v1/responses"
    OPENAI_EMBEDDINGS_URL: str = "https://api.openai.com/v1/embeddings"
    OPENAI_EMBEDDING_MODEL: str = "text-embedding-3-small"

    # Internal auth
    NEXA_SERVICE_SECRET: str = ""

    # End-user auth (SSO)
    AUTH_MODE: Literal["disabled", "optional", "required"] = "disabled"
    AZURE_AD_TENANT_ID: str = ""
    AZURE_AD_CLIENT_ID: str = ""
    AZURE_AD_ISSUER: str = ""
    GOOGLE_OAUTH_CLIENT_ID: str = ""
    AUTH_JWT_SECRET: str = "bxc09TnIBmTsrlH1awW5HRtn1BgbbThZPLAPNH8n1qa9fOeDxls_3dLHoYJL9anz"
    AUTH_JWT_TTL_SECONDS: int = 60 * 60 * 24 * 7
    AUTH_PASSWORD_RESET_TOKEN_TTL_MINUTES: int = 60
    AUTH_PASSWORD_RESET_URL: str = "http://localhost:3000/reset-password?token={token}"

    # CORS
    CORS_ALLOW_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Azure Storage
    AZURE_STORAGE_ACCOUNT_URL: str = ""
    AZURE_STORAGE_ACCOUNT_NAME: str = ""
    AZURE_STORAGE_ACCOUNT_KEY: str = ""
    AZURE_STORAGE_CONTAINER: str = ""
    AZURE_STORAGE_UPLOAD_TTL_MINUTES: int = 10
    AZURE_STORAGE_DOWNLOAD_TTL_MINUTES: int = 5

    # Azure Queue (OCR processing)
    AZURE_QUEUE_NAME: str = "nexaquill-ocr"
    AZURE_QUEUE_CONNECTION_STRING: str = ""
    AZURE_QUEUE_ACCOUNT_URL: str = ""
    AZURE_QUEUE_ACCOUNT_NAME: str = ""
    AZURE_QUEUE_ACCOUNT_KEY: str = ""
    AZURE_QUEUE_VISIBILITY_TIMEOUT: int = 30

    # Azure Form Recognizer
    AZURE_FORM_RECOGNIZER_ENDPOINT: str = ""
    AZURE_FORM_RECOGNIZER_KEY: str = ""

    # Embeddings (pgvector)
    AZURE_OPENAI_DEPLOYMENT_EMBEDDING: str = ""
    EMBEDDING_DIMENSION: int = 1536
    EMBEDDING_MAX_CHUNKS: int = 60
    EMBEDDING_CHUNK_SIZE: int = 900
    EMBEDDING_CHUNK_OVERLAP: int = 120

    # Optional Bing Web Search grounding (Azure Cognitive Services)
    AZURE_BING_SEARCH_ENDPOINT: str = ""
    AZURE_BING_SEARCH_KEY: str = ""

    # Optional Tavily web grounding (recommended if you need general web citations)
    TAVILY_API_KEY: str = ""

    DATABASE_URL: str = ""

    LOG_LEVEL: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"

    # Admin console
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "pass"
    ADMIN_TOKEN_TTL_SECONDS: int = 60 * 60 * 4
    VOICE_SESSION_TOKEN_COST: int = 600


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
