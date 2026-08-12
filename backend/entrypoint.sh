#!/bin/sh
set -e
# Migrate the schema before starting.
# In the container's start-up rather than run by hand -- the store has no IT, so deploying has to be one command.
echo "[entrypoint] running migrations..."
alembic upgrade head
echo "[entrypoint] starting api..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
