@echo off
echo ========================================
echo         OCS Desktop Working Start
echo ========================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js not found, please install Node.js first
    pause
    exit /b 1
)

:: Check pnpm
pnpm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: pnpm not found, please install pnpm first
    pause
    exit /b 1
)

:: Check dependencies
if not exist "node_modules" (
    echo Installing dependencies...
    pnpm install
    if %errorlevel% neq 0 (
        echo Dependency install failed, trying Tsinghua mirror...
        pnpm install --registry=https://registry.npmmirror.com
        if %errorlevel% neq 0 (
            echo Error: dependency installation failed
            pause
            exit /b 1
        )
    )
    echo Dependencies installed
)

:: Check videos directory
if not exist "videos" (
    mkdir videos
    echo Created videos directory
)

:: Start application
echo.
echo ========================================
echo         Starting OCS Desktop...
echo ========================================
echo.
pnpm dev

pause