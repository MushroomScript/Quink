@echo off
setlocal EnableDelayedExpansion
title Quink Desktop Launcher
cd /d %~dp0

echo.
echo ============================================
echo   Quink 桌面端启动
echo ============================================
echo.

REM ---------- 1/4 检查后端 ----------
echo [1/4] 检查后端 ^(38999^)...
curl -s -f -o nul --max-time 2 http://localhost:38999/api/health
if errorlevel 1 (
    echo.
    echo [错误] 后端无响应，请先双击 start-server.bat 启动后端
    echo.
    pause
    exit /b 1
)
echo       后端已就绪

REM ---------- 2/4 启动前端 Vite ----------
echo [2/4] 启动前端 Vite ^(24888^)...
netstat -ano | findstr ":24888" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo       Vite 已在运行
    goto compile_desktop
)

start "Quink Web" /min cmd /c "cd /d %~dp0 && pnpm run dev:web"
echo       已拉起 Vite 进程，等待就绪...

set /a __retry=0
:wait_web
timeout /t 1 /nobreak >nul
curl -s -o nul --max-time 2 http://localhost:24888/
if not errorlevel 1 goto web_ready
set /a __retry+=1
if !__retry! gtr 30 (
    echo.
    echo [错误] 前端 30 秒内未就绪，请检查 "Quink Web" 窗口日志
    pause
    exit /b 1
)
goto wait_web

:web_ready
echo       前端已就绪

:compile_desktop
REM ---------- 3/4 编译桌面端 ----------
echo [3/4] 编译桌面端 TypeScript...
call pnpm --filter @quink/desktop exec tsc
if errorlevel 1 (
    echo.
    echo [错误] TypeScript 编译失败
    pause
    exit /b 1
)
echo       编译完成

REM ---------- 4/4 启动 Electron ----------
echo [4/4] 启动 Electron...
start "Quink Desktop" cmd /c "cd /d %~dp0 && pnpm --filter @quink/desktop exec electron ."

echo.
echo ============================================
echo   启动完成，Electron 窗口即将弹出
echo ============================================
timeout /t 2 >nul
exit