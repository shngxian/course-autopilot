@echo off
echo ========================================
echo         OCS Desktop Start System
echo ========================================
echo.

:: Check Node.js
echo [1/7] Checking Node.js...
call node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js not found, please install Node.js first
    echo.
    pause
    exit /b 1
)
echo Node.js installed

:: Check pnpm
echo [2/7] Checking pnpm...
call pnpm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo pnpm not found in PATH, trying to locate it...
    :: Try common npm global locations
    if exist "%APPDATA%\npm\pnpm.cmd" (
        echo Found pnpm at: %APPDATA%\npm\pnpm.cmd
        set "PATH=%APPDATA%\npm;%PATH%"
    ) else if exist "%USERPROFILE%\AppData\Roaming\npm\pnpm.cmd" (
        echo Found pnpm at: %USERPROFILE%\AppData\Roaming\npm\pnpm.cmd
        set "PATH=%USERPROFILE%\AppData\Roaming\npm;%PATH%"
    ) else (
        echo Error: pnpm not found, please install pnpm first
        echo Run: npm install -g pnpm
        echo.
        pause
        exit /b 1
    )
)
echo pnpm installed

:: Check dependencies
echo [3/7] Checking dependencies...
if not exist "node_modules" (
    echo Installing dependencies...
    call pnpm install
    if %errorlevel% neq 0 (
        echo Error: dependency installation failed
        echo.
        pause
        exit /b 1
    )
    echo Dependencies installed
) else (
    echo Dependencies installed
)

:: Check TypeScript compilation
echo [4/7] Checking TypeScript compilation...
if not exist "lib" (
    echo Compiling TypeScript...
    pushd ..
    call npx gulp -f ./scripts/tsc.js
    popd
    if %errorlevel% neq 0 (
        echo Error: TypeScript compilation failed
        echo.
        pause
        exit /b 1
    )
    echo TypeScript compiled
) else (
    echo TypeScript compiled
)

:: Check videos directory
echo [5/7] Checking videos directory...
if not exist "videos" (
    mkdir videos
    echo Created videos directory
) else (
    echo videos directory exists
)

:: Build web frontend (for Express server static files)
echo [6/7] Building web frontend...
pushd ..\..
call pnpm --filter @ocs-desktop/web exec vite build --emptyOutDir
if %errorlevel% neq 0 (
    echo Warning: Web build failed, trying to continue anyway...
)
popd

:: Start application (common + web + app concurrently)
echo [7/7] Starting application...
echo.
echo ========================================
echo         Starting OCS Desktop...
echo  (common + web + app all started)
echo ========================================
echo.

:: Go to project root and run pnpm dev (starts all 3 workspaces)
pushd ..\..
call pnpm dev
popd

echo.
echo Application exited.
pause