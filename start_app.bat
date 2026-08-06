@echo off
echo ==========================================
echo      STARTING NEXUS DASHBOARD SYSTEM
echo ==========================================
echo.

echo [1/3] Starting Backend Server on port 4000...
start "Backend - Port 4000" cmd /k "node server.cjs"
timeout /t 2 /nobreak >nul

echo [2/3] Starting Job Worker...
start "Job Worker" cmd /k "node dist/index.js worker"
timeout /t 2 /nobreak >nul

echo [3/3] Starting Frontend Dashboard on port 3000...
cd /d "%~dp0Frontend"
call npm install --silent
start "Frontend - Port 3000" cmd /k "npm run dev"
cd /d "%~dp0"

echo.
echo ==========================================
echo      SYSTEM LAUNCHED SUCCESSFULLY
echo ==========================================
echo.
echo  Dashboard : http://localhost:3000
echo  Backend   : http://localhost:4000
echo  Worker    : Running (processing jobs)
echo.
echo Press any key to exit this window...
pause >nul
