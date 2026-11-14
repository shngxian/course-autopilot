@echo off
taskkill /F /IM electron.exe 2>nul
taskkill /F /IM node.exe 2>nul
timeout /t 2 /nobreak >nul
cd /d D:\wo_de_cheng_xu\跳人脸刷课\ocs-desktop\packages\app
start "" cmd /c start-system.bat
