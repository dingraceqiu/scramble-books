#!/bin/bash
set -Eeuo pipefail

COZE_WORKSPACE_PATH="${COZE_WORKSPACE_PATH:-$(pwd)}"

cd "${COZE_WORKSPACE_PATH}"

echo "Installing dependencies..."
pnpm install --prefer-frozen-lockfile --prefer-offline --loglevel debug --reporter=append-only

echo "Building frontend with Vite..."
pnpm vite build

echo "Bundling server with tsup..."
pnpm tsup --config tsup.config.ts

echo "Build completed successfully!"
