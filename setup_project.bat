@echo off
echo ===================================================
echo   Google Workspace Automation - Project Setup
echo ===================================================

echo.
echo [1/4] Checking Node.js installation...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed! Please install it from https://nodejs.org/
    pause
    exit /b 1
)
echo [OK] Node.js is installed.

echo.
echo [2/4] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo [3/4] Building project...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Failed to build project.
    pause
    exit /b 1
)

echo.
echo [4/4] Setup complete!
echo.
echo To start the worker, run: node dist/index.js worker
echo.
pause
