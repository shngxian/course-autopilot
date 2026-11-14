@echo off
echo ========================================
echo         Install pnpm
echo ========================================
echo.

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js not found, please install Node.js first
    pause
    exit /b 1
)

:: Install pnpm
echo Installing pnpm...
npm install -g pnpm

:: Verify installation
pnpm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: pnpm installation failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo         pnpm Installed
echo ========================================
echo.
echo Now you can run install-deps.bat to install dependencies
pause