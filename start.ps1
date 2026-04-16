$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "Quink - 速思"
Set-Location "G:\WorkSpace\VSCodeProjects\Quink"

Write-Host ""
Write-Host "  [Quink] 正在启动..." -ForegroundColor Cyan
Write-Host ""

# 启动后端
try { $null = Invoke-WebRequest -Uri "http://localhost:38999/api/health" -UseBasicParsing -TimeoutSec 1; Write-Host "  [OK] 后端已在运行" -ForegroundColor Green } catch {
    Write-Host "  [..] 启动后端..."
    Start-Process -FilePath "pnpm" -ArgumentList "run","dev:server" -WorkingDirectory "G:\WorkSpace\VSCodeProjects\Quink" -WindowStyle Minimized
    do { Start-Sleep 1; try { $null = Invoke-WebRequest -Uri "http://localhost:38999/api/health" -UseBasicParsing -TimeoutSec 1; $ok=$true } catch { $ok=$false } } while(-not $ok)
    Write-Host "  [OK] 后端已启动" -ForegroundColor Green
}

# 启动前端
try { $null = Invoke-WebRequest -Uri "http://localhost:9211/" -UseBasicParsing -TimeoutSec 1; Write-Host "  [OK] 前端已在运行" -ForegroundColor Green } catch {
    Write-Host "  [..] 启动前端..."
    Start-Process -FilePath "pnpm" -ArgumentList "run","dev:web" -WorkingDirectory "G:\WorkSpace\VSCodeProjects\Quink" -WindowStyle Minimized
    do { Start-Sleep 1; try { $null = Invoke-WebRequest -Uri "http://localhost:9211/" -UseBasicParsing -TimeoutSec 1; $ok=$true } catch { $ok=$false } } while(-not $ok)
    Write-Host "  [OK] 前端已启动" -ForegroundColor Green
}

# 编译桌面端
Write-Host "  [..] 编译桌面端..."
Set-Location "G:\WorkSpace\VSCodeProjects\Quink\packages\desktop"
& npx tsc
if ($LASTEXITCODE -ne 0) {
    Write-Host "  [ERROR] 编译失败！" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

# 启动 Electron
Write-Host "  [OK] 启动桌面端..." -ForegroundColor Green
Write-Host ""
& npx electron .
