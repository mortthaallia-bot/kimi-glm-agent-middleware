@echo off
title Kimi & GLM Agent Middleware - 24/7 Watchdog
cd /d "%~dp0\.."

echo ========================================================
echo   Starting Kimi & GLM Autonomous Agent Middleware
echo   Watchdog Status: http://localhost:8099/status
echo   Kimi Agent Endpoint: http://localhost:8001/v1
echo   GLM Agent Endpoint:  http://localhost:3000/v1
echo   Z.ai Bridge:         http://localhost:8002/v1
echo ========================================================

node watchdog\watchdog.js
pause
