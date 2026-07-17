# Flask epic-generator (Gemini) — waitress, non-root.
# Internal-only service: reached by the backend over the compose network and
# gated by INTERNAL_API_KEY. Not published to the host.
#
# waitress (not gunicorn) is deliberate: it's already a dependency, it's what
# web_app.py documents, and a single multi-threaded process avoids running N
# copies of anything. --channel-timeout=300 covers slow (60-120s) Gemini calls.

FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=5000
WORKDIR /app

# Dependencies first for layer caching.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Unprivileged runtime user.
RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,os,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','5000')+'/api/health').status==200 else 1)"

CMD ["sh", "-c", "waitress-serve --host=0.0.0.0 --port=${PORT} --threads=8 --channel-timeout=300 web_app:app"]
