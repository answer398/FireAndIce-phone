#!/usr/bin/env bash
# Development launcher: installs deps on first run, then starts the
# static + Socket.IO server with watch-mode restarts.
set -e
cd "$(dirname "$0")/../server"
[ -d node_modules ] || npm install
NODE_ENV=development exec node --watch src/index.js
