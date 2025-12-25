FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Install deps (uv.lock is used for reproducible installs)
COPY pyproject.toml uv.lock* README.md /app/
RUN pip install --no-cache-dir -U pip uv \
  && uv sync --frozen

COPY . /app

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "nexaquill_api.main:app", "--host", "0.0.0.0", "--port", "8000"]

