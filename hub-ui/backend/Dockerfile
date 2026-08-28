FROM python:3.12-slim

WORKDIR /app

# Minimal deps — no ML libraries, just API routing + SQLite + GPU stats
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Backend kódy
COPY app.py .
COPY hub.py .
COPY proxy.py .
COPY stt.py .
COPY video.py .
COPY llm.py .
COPY services.py .
COPY webui_registry.py .

# SPA (frontend) — mounted volume v docker-compose, ale COPY záloha pro build
# COPY ../../frontend /app/static

ENV WEBAPP_DIR=/app/static \
    WEBAPP_DB=/data/webapp.db \
    HUB_MACHINES_FILE=/app/machines.yaml

# SQLite state (history, templates)
VOLUME ["/data"]

EXPOSE 8288

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=10s \
  CMD python3 -c "import httpx; httpx.get('http://localhost:8288/api/health')"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8288"]
