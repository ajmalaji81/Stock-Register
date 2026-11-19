import os

os.environ.setdefault("AUTH_SECRET", "test-secret-test-secret-test-secret-123456")
os.environ["APP_ENV"] = "development"

import pytest
from fastapi.testclient import TestClient

from app import db as dbmod
from app.main import create_app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # The app's lifespan binds the engine from DATABASE_URL, so point it at a throwaway file.
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    with TestClient(create_app()) as c:
        yield c
    dbmod.get_engine().dispose()


def signup(c, email="owner@example.com", name="Owner", password="password123"):
    r = c.post("/api/auth/signup", json={"name": name, "email": email, "password": password})
    assert r.status_code == 201, r.text
    return r


def make_free(email="owner@example.com"):
    """Expire the 90-day trial so the Free plan limits apply."""
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import update

    from app.models import User

    with dbmod.session_scope() as s:
        s.execute(update(User).where(User.email == email).values(trialEndsAt=datetime.now(timezone.utc) - timedelta(days=1)))
