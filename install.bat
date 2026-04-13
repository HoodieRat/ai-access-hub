@echo off
setlocal EnableDelayedExpansion

REM ── AI Access Hub – Windows install script ───────────────────────────────────

cd /d "%~dp0"

echo ╔═══════════════════════════════════════════╗
echo ║         AI Access Hub – Install           ║
echo ╚═══════════════════════════════════════════╝
echo.

REM Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: node.exe not found.
    echo   Install Node.js 18+ from https://nodejs.org/en/download
    pause
    exit /b 1
)

for /f "delims=v." %%M in ('node --version 2^>nul') do set NODE_MAJOR=%%M
if !NODE_MAJOR! LSS 18 (
    echo ERROR: Node.js 18 or higher required. Found version !NODE_MAJOR!
    pause
    exit /b 1
)
echo [OK] Node.js !NODE_MAJOR! detected

REM Check npm
where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm not found. Install Node.js from https://nodejs.org
    pause
    exit /b 1
)
echo [OK] npm detected

REM Create .env if missing
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [OK] Created .env from .env.example
        echo.
        echo IMPORTANT: Open .env and set at minimum:
        echo   HUB_SECRET_KEY  ^(32+ random chars^)
        echo   HUB_ADMIN_TOKEN ^(16+ chars^)
        echo   At least one provider API key ^(e.g. GEMINI_API_KEY^)
        echo.
    )
) else (
    echo [OK] .env already exists
)

set HUB_PORT=3000
for /f "tokens=1,* delims==" %%A in ('findstr /b "HUB_PORT=" ".env"') do set HUB_PORT=%%B

REM Create data directory
if not exist "data" mkdir data
echo [OK] data\\ directory ready

REM Install npm dependencies
echo.
echo Installing npm dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)
echo [OK] Dependencies installed

REM Build TypeScript
echo.
echo Building TypeScript...
call npm run build
if errorlevel 1 (
    echo ERROR: TypeScript build failed. Check errors above.
    pause
    exit /b 1
)
echo [OK] Build successful

echo.
echo ╔═══════════════════════════════════════════╗
echo ║          Installation complete!           ║
echo ╚═══════════════════════════════════════════╝
echo.
echo Next steps:
echo   1. Edit .env to add your provider API keys
echo   2. Run start.bat to launch the hub
echo   3. Use stop.bat for a clean shutdown
echo   4. Open http://127.0.0.1:!HUB_PORT!/dashboard
echo.
pause
