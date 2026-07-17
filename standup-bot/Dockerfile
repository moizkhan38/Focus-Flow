# Slack standup bot (Flask + APScheduler) — waitress, non-root.
# Internal-only: reached by the backend over the compose network + gated by
# INTERNAL_API_KEY; Slack reaches /slack/* via the backend/ingress, not the host.
#
# waitress (single multi-threaded process) is REQUIRED here, not just preferred:
# APScheduler runs in-process, so gunicorn -w N would fire every daily reminder
# N times. One process = the scheduler runs once.

FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    STANDUP_DATA_FILE=/app/data/standup_data.json
WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Persist standup_data.json outside the image layer (compose mounts a volume at
# /app/data). Created + owned before dropping privileges.
RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','3000')+'/api/health').status==200 else 1)"

CMD ["sh", "-c", "waitress-serve --host=0.0.0.0 --port=${PORT} --threads=8 app:app"]
