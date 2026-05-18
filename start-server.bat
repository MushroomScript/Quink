@echo off
title Quink Server
cd /d %~dp0

echo.
echo ============================================
echo   Quink 后端服务   端口 38999
echo ============================================
echo.

REM 检查端口占用（只看 LISTENING）
netstat -ano | findstr ":38999" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [警告] 端口 38999 已被占用，后端可能已在运行
    echo.
    echo 查 PID：     netstat -ano ^| findstr :38999
    echo 强制结束：   taskkill /F /PID ^<pid^>
    echo.
    pause
    exit /b 1
)

echo [Quink] 启动后端 pnpm run dev:server
echo [Quink] 关闭此窗口即可停止服务
echo.

call pnpm run dev:server

echo.
echo [Quink] 后端已停止
pause