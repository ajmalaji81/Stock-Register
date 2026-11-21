"""Aggregates the section routers. Each module below exposes `router`; missing ones are skipped."""
from importlib import import_module
from pathlib import Path

from fastapi import APIRouter

STATIC_DIR = Path(__file__).parent / "static"
STATIC_DIR.mkdir(exist_ok=True)
router = APIRouter()

for _name in ("auth_pages", "stock_pages", "billing_pages", "money_pages", "serial_pages", "workspace_pages", "accounts_pages", "inventory_pages", "books_pages", "analysis_pages"):
    try:
        router.include_router(import_module(f"app.web.{_name}").router)
    except ModuleNotFoundError as e:  # section not written yet
        if e.name != f"app.web.{_name}":
            raise
