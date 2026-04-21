#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "[deploy] atualizando repositorio..."
git pull --ff-only

echo "[deploy] rebuild e deploy dos containers..."
docker compose up -d --build --remove-orphans

echo "[deploy] status:"
docker compose ps
