"""Engine and session handling."""
from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator, Optional

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from . import config
from .models import Base

_engine: Optional[Engine] = None
_factory: Optional[sessionmaker] = None


def make_engine(url: Optional[str] = None) -> Engine:
    url = url or config.database_url()
    kwargs: dict = {}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 15}
        if ":memory:" in url or url == "sqlite://":
            from sqlalchemy.pool import StaticPool

            kwargs["poolclass"] = StaticPool
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _pragmas(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")  # ON DELETE CASCADE / RESTRICT rules from the schema
            cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

    return engine


def init_db(url: Optional[str] = None) -> Engine:
    """(Re)bind the global engine and create any missing tables."""
    global _engine, _factory
    _engine = make_engine(url)
    _factory = sessionmaker(_engine, expire_on_commit=False)
    Base.metadata.create_all(_engine)
    _add_missing_columns(_engine)
    return _engine


#: (table, column, DDL type + default). create_all never alters existing tables, so older databases get these here.
_NEW_COLUMNS = [
    ("Voucher", "modifiedBy", "TEXT NOT NULL DEFAULT ''"),
    ("Voucher", "modifiedAt", "INTEGER"),
    ("Voucher", "paymentInfo", "TEXT NOT NULL DEFAULT ''"),
    ("Voucher", "schemeInfo", "TEXT NOT NULL DEFAULT ''"),
    ("Voucher", "paymentSplit", "TEXT NOT NULL DEFAULT '[]'"),
    ("PartyPayment", "withBill", "BOOLEAN NOT NULL DEFAULT 0"),
    ("Item", "trackSerial", "BOOLEAN NOT NULL DEFAULT 0"),
    ("VoucherLine", "serials", "TEXT NOT NULL DEFAULT '[]'"),
    ("Godown", "state", "TEXT NOT NULL DEFAULT ''"),
    ("Godown", "gstin", "TEXT NOT NULL DEFAULT ''"),
    ("Godown", "address", "TEXT NOT NULL DEFAULT ''"),
    ("Party", "linkedGodownId", "TEXT"),
    ("Voucher", "branchStatus", "TEXT NOT NULL DEFAULT ''"),
    ("Voucher", "branchGodownId", "TEXT"),
    ("Voucher", "branchVoucherId", "TEXT"),
    ("Voucher", "branchBy", "TEXT NOT NULL DEFAULT ''"),
    ("Voucher", "branchAt", "INTEGER"),
    ("Voucher", "linkedVoucherId", "TEXT"),
    ("Voucher", "history", "BOOLEAN NOT NULL DEFAULT 0"),
]


def _add_missing_columns(engine: Engine) -> None:
    from sqlalchemy import inspect, text

    insp = inspect(engine)
    added_with_bill = False
    with engine.begin() as conn:
        for table, col, ddl in _NEW_COLUMNS:
            if not insp.has_table(table):
                continue
            if col in {c["name"] for c in insp.get_columns(table)}:
                continue
            if engine.dialect.name == "postgresql":
                ddl = ddl.replace("DEFAULT 0", "DEFAULT FALSE")
            conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{col}" {ddl}'))
            added_with_bill = added_with_bill or col == "withBill"
        if added_with_bill:  # payments recorded together with a bill before this column existed
            flag = "TRUE" if engine.dialect.name == "postgresql" else "1"
            conn.execute(text(
                f'UPDATE "PartyPayment" SET "withBill" = {flag} WHERE "voucherId" IS NOT NULL AND "notes" LIKE \'With %\''
            ))


def get_engine() -> Engine:
    if _engine is None:
        init_db()
    assert _engine is not None
    return _engine


def session_factory() -> sessionmaker:
    if _factory is None:
        init_db()
    assert _factory is not None
    return _factory


@contextmanager
def session_scope() -> Iterator[Session]:
    """One transaction: commit on success, roll back on any error."""
    s = session_factory()()
    try:
        yield s
        s.commit()
    except BaseException:
        s.rollback()
        raise
    finally:
        s.close()
