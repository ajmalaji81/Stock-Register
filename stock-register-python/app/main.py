"""GodownBook (Python edition): FastAPI application entry point.

Run:  uvicorn app.main:app --reload --port 8000
"""
from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

from . import config
from .api.routes import router as api_router
from .core.errors import StockError
from .db import init_db
from .schemas import first_message

log = logging.getLogger("godownbook")


class RevalidatingStaticFiles(StaticFiles):
    """Serve static files with `Cache-Control: no-cache`: browsers re-check (cheap, via ETag) before reusing a copy,
    so a deploy is never hidden behind a stale cached app.css / script."""

    async def get_response(self, path, scope):
        res = await super().get_response(path, scope)
        res.headers["Cache-Control"] = "no-cache"
        return res


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.auth_secret()  # fail fast when AUTH_SECRET is missing or short
    init_db()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="GodownBook", lifespan=lifespan, docs_url="/api/docs" if not config.is_production() else None, redoc_url=None, openapi_url="/api/openapi.json" if not config.is_production() else None)

    @app.exception_handler(StockError)
    async def _stock_error(_req: Request, exc: StockError):
        body = {"error": exc.message}
        if exc.code:
            body["code"] = exc.code
        return JSONResponse(body, status_code=exc.status)

    from .web.common import LoginRedirect, redirect as web_redirect

    @app.exception_handler(LoginRedirect)
    async def _login_redirect(_req: Request, _exc: LoginRedirect):
        return web_redirect("/login")

    @app.exception_handler(RequestValidationError)
    async def _request_invalid(_req: Request, exc: RequestValidationError):
        return JSONResponse({"error": first_message(exc)}, status_code=400)

    @app.exception_handler(ValidationError)
    async def _invalid(_req: Request, exc: ValidationError):
        return JSONResponse({"error": first_message(exc)}, status_code=400)

    @app.exception_handler(IntegrityError)
    async def _integrity(_req: Request, _exc: IntegrityError):
        return JSONResponse({"error": "That name / SKU already exists"}, status_code=409)

    @app.exception_handler(Exception)
    async def _unhandled(_req: Request, exc: Exception):
        log.exception("Unhandled error", exc_info=exc)
        return JSONResponse({"error": "Something went wrong"}, status_code=500)

    @app.middleware("http")
    async def pdf_export(request: Request, call_next):
        """Any CSV download also works as a PDF: `?format=pdf`, or the same URL ending `.pdf` instead of `.csv`."""
        path = request.url.path
        if request.method != "GET" or not (request.query_params.get("format") == "pdf" or path.endswith(".pdf")):
            return await call_next(request)
        from urllib.parse import parse_qsl, urlencode

        from .core.export import rows_from_csv, to_pdf

        scope = request.scope
        if path.endswith(".pdf"):
            scope["path"] = path[:-4] + ".csv"
            scope["raw_path"] = scope["path"].encode()
        query = [(k, "csv" if k == "format" else v) for k, v in parse_qsl(request.url.query, keep_blank_values=True)]
        scope["query_string"] = urlencode(query).encode()
        res = await call_next(request)
        if not res.headers.get("content-type", "").startswith("text/csv"):
            return res  # a redirect or an error page: pass it on unchanged
        raw = b"".join([chunk async for chunk in res.body_iterator]).decode("utf-8-sig", "replace")
        m = re.search(r'filename="([^"]+)"', res.headers.get("content-disposition", ""))
        base = re.sub(r"\.csv$", "", m.group(1)) if m else "report"
        pdf = to_pdf(base.replace("-", " ").replace("_", " ").title(), rows_from_csv(raw))
        return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{base}.pdf"'})

    app.include_router(api_router)

    from .web.pages import router as web_router, STATIC_DIR

    app.mount("/static", RevalidatingStaticFiles(directory=STATIC_DIR), name="static")
    app.include_router(web_router)
    return app


app = create_app()
