@echo off
REM Doble clic para iniciar CESVI con el asistente de Ollama.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iniciar-cesvi.ps1" %*
pause
