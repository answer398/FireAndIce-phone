#!/usr/bin/env bash
# Production launcher: install deps (omit if baked into the image) and run
# the server. Put HTTPS/WSS termination in nginx/Caddy in front of this.
set -e
cd "$(dirname "$0")/../server"
[ -d node_modules ] || npm install --omit=dev
NODE_ENV=production exec node src/index.js
