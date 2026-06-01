# Nexus Local Startup Script
# Ybda WSL Redis 8 + updates .env + ybda server

$ProjectDir = $PSScriptRoot

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "   NEXUS LOCAL STARTUP" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Bda WSL Redis 8
Write-Host "[1/4] Kaybda WSL Redis 8..." -ForegroundColor Yellow
wsl -u root -e bash -c "service redis-server start" | Out-Null
Start-Sleep -Seconds 2

# Step 2: Get WSL IP
Write-Host "[2/4] Katget WSL IP..." -ForegroundColor Yellow
$WSL_IP = (wsl -u root -e bash -c "hostname -I").Trim().Split(" ")[0]
Write-Host "      WSL IP: $WSL_IP" -ForegroundColor Green

# Test Redis
$redisPong = wsl -u root -e bash -c "redis-cli -p 6380 ping" 2>&1
if ($redisPong -notmatch "PONG") {
    Write-Host "      Redis machi khaddam - jrb restart..." -ForegroundColor Red
    wsl -u root -e bash -c "service redis-server restart" | Out-Null
    Start-Sleep -Seconds 3
    $WSL_IP = (wsl -u root -e bash -c "hostname -I").Trim().Split(" ")[0]
}
Write-Host "      Redis 8.8.0 khaddam" -ForegroundColor Green

# Step 3: Update .env
Write-Host "[3/4] Katupdate .env..." -ForegroundColor Yellow
$envPath = Join-Path $ProjectDir ".env"
$lines = Get-Content $envPath
$newLines = $lines | ForEach-Object {
    if ($_ -match "^REDIS_HOST=") { "REDIS_HOST=$WSL_IP" }
    elseif ($_ -match "^REDIS_PORT=") { "REDIS_PORT=6380" }
    else { $_ }
}
$newLines | Set-Content $envPath
Write-Host "      .env updated: REDIS_HOST=$WSL_IP:6380" -ForegroundColor Green

# Step 4: Start
Write-Host "[4/4] Kol chi mzian - katbda..." -ForegroundColor Yellow
Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "   Dashboard: http://localhost:4000" -ForegroundColor Green
Write-Host "   Redis:     $WSL_IP`:6380 (v8.8.0)" -ForegroundColor Green
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

Set-Location $ProjectDir
node server.js
