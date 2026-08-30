@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" http://localhost:8770
python server.py 8770
pause
