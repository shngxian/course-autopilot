@echo off
echo ========================================
echo         Install Dependencies
echo ========================================
echo.

:: Set mirror
echo Setting npm mirror to Tsinghua...
npm config set registry https://registry.npmmirror.com
pnpm config set registry https://registry.npmmirror.com

:: Install dependencies
echo Installing dependencies...
pnpm install

if %errorlevel% neq 0 (
    echo Error: dependency installation failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo         Dependencies Installed
echo ========================================
echo.
echo Now you can run start-system.bat to start the app
pause