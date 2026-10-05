@echo off
rem Development launcher (Windows): installs deps on first run, then starts
rem the static + Socket.IO server with watch-mode restarts.
cd /d "%~dp0..\server"
if not exist node_modules call npm install
set NODE_ENV=development
node --watch src/index.js
