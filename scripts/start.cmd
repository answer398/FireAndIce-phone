@echo off
rem Production launcher (Windows): install deps (omit if baked into the image)
rem and run the server in front. Put HTTPS/WSS termination in nginx/Caddy.
cd /d "%~dp0..\server"
if not exist node_modules call npm install --omit=dev
set NODE_ENV=production
node src/index.js
