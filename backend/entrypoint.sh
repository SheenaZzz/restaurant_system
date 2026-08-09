#!/bin/sh
set -e
# 启动前先把 schema 迁到最新。
# 放在容器启动里而不是手动执行 —— 店里没有 IT，部署必须是一条命令。
echo "[entrypoint] running migrations..."
alembic upgrade head
echo "[entrypoint] starting api..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
