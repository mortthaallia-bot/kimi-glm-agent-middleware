@echo off
title Install Dependencies - Kimi & GLM Agent Middleware
cd /d "%~dp0"

echo [1/3] Installing dependencies for kimi-agent-server...
cd kimi-agent-server
call npm install
cd ..

echo.
echo [2/3] Installing dependencies for glm-agent-server...
cd glm-agent-server
call npm install
cd ..

echo.
echo [3/3] Installing dependencies for zai-proxy...
cd zai-proxy
call npm install
cd ..

echo.
echo ========================================================
echo   Installation Complete!
echo   Double-click start-all.bat to run all servers.
echo ========================================================
pause
