@echo off
setlocal
cd /d "%~dp0"
echo [local-ai-bridge] starting on http://127.0.0.1:8765
node "%~dp0local-ai-bridge.mjs"
