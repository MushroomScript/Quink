@echo off
cd /d G:\WorkSpace\VSCodeProjects\Quink

echo [Quink] Starting services...
start "" /min cmd /c "cd /d G:\WorkSpace\VSCodeProjects\Quink && pnpm run dev:server"
start "" /min cmd /c "cd /d G:\WorkSpace\VSCodeProjects\Quink && pnpm run dev:web"

echo [Quink] Waiting for backend...
:wait1
ping 127.0.0.1 -n 3 >nul
"C:\Program Files\nodejs\npx.cmd" --yes node -e "fetch('http://localhost:38999/api/health').then(r=>{if(r.ok)process.exit(0);process.exit(1)}).catch(()=>process.exit(1))" >nul 2>&1
if errorlevel 1 goto wait1
echo [OK] Backend ready

echo [Quink] Waiting for frontend...
:wait2
ping 127.0.0.1 -n 3 >nul
"C:\Program Files\nodejs\npx.cmd" --yes node -e "fetch('http://localhost:24888/').then(r=>{if(r.ok)process.exit(0);process.exit(1)}).catch(()=>process.exit(1))" >nul 2>&1
if errorlevel 1 goto wait2
echo [OK] Frontend ready

echo [Quink] Starting desktop...
cd /d G:\WorkSpace\VSCodeProjects\Quink\packages\desktop
call "C:\Program Files\nodejs\npx.cmd" tsc 2>nul
start "" "C:\Program Files\nodejs\npx.cmd" electron .
echo [OK] Done
timeout /t 2 >nul
exit
