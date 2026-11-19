# GodownBook (Python) production image: FastAPI + uvicorn, SQLite on a volume.
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    APP_ENV=production \
    PORT=8000

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
COPY docker/entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh \
    && useradd --system --uid 10001 --home /app app \
    && mkdir -p /data && chown app:app /data

USER app
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/login'%os.environ.get('PORT','8000'),timeout=4)" || exit 1
ENTRYPOINT ["/entrypoint.sh"]
