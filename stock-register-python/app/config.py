"""Environment configuration (same variable names as the TypeScript app's .env)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Tiny .env reader (no extra dependency). Real environment variables win."""
    path = ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if value[:1] in "\"'" and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        os.environ.setdefault(key.strip(), value)


_load_dotenv()


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def is_production() -> bool:
    return env("APP_ENV", "development") == "production"


def auth_secret() -> str:
    s = env("AUTH_SECRET")
    if len(s) < 32:
        raise RuntimeError("AUTH_SECRET must be set (32+ characters)")
    return s


def app_url() -> str:
    return (env("APP_URL") or env("NEXT_PUBLIC_APP_URL") or "http://localhost:8000").rstrip("/")


def database_url() -> str:
    """Accepts Prisma-style `file:./dev.db` as well as SQLAlchemy URLs."""
    url = env("DATABASE_URL", "file:./dev.db")
    if url.startswith("file:"):
        rel = url[len("file:"):]
        path = Path(rel)
        if not path.is_absolute():
            path = ROOT / path
        return f"sqlite:///{path.as_posix()}"
    if url.startswith("postgres://"):
        return "postgresql+psycopg://" + url[len("postgres://"):]
    return url


def smtp_settings() -> dict:
    """SMTP for password-reset mail. host == "" means not configured (links are logged instead)."""
    user = env("SMTP_USER")
    return {
        "host": env("SMTP_HOST"), "port": int(env("SMTP_PORT", "587") or 587), "user": user,
        "password": env("SMTP_PASSWORD"), "sender": env("SMTP_FROM") or user,
    }
