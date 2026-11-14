@echo off
title 一键刷课（保持窗口开着）
cd /d "%~dp0"
echo ============================================
echo   一键刷课启动中...
echo   浏览器会自动打开 千问x3 + 课程入口
echo   进入课程章节页后全自动：视频-答题-提交-下一章
echo   停止 = 关闭本窗口 或 关闭浏览器
echo ============================================
start "OCS脚本服务" /min cmd /c "node serve.js"
timeout /t 2 /nobreak >nul
node launch-user.js
echo.
echo 浏览器已退出，3秒后自动关闭...
timeout /t 3 /nobreak >nul
