# Worker Progress Monitor (ASCII version)
# This script monitors the worker progress in real-time

Write-Host "=== Worker Progress Monitor ===" -ForegroundColor Cyan
Write-Host ""

# Function to check browser status
function Get-BrowserStatus {
    $chrome = Get-Process chrome -ErrorAction SilentlyContinue
    if ($chrome) {
        return "[OK] Running ($($chrome.Count) processes)"
    }
    return "[NO] Not running"
}

# Function to get latest screenshot
function Get-LatestScreenshot {
    $latest = Get-ChildItem *.png -ErrorAction SilentlyContinue | 
    Sort-Object LastWriteTime -Descending | 
    Select-Object -First 1
    
    if ($latest) {
        return $latest
    }
    return $null
}

# Function to tail file
function Get-FileTail {
    param([string]$Path, [int]$Lines = 10)
    
    if (Test-Path $Path) {
        return Get-Content $Path -Tail $Lines -ErrorAction SilentlyContinue
    }
    return @()
}

Write-Host "Starting monitor... Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

$iteration = 0
$lastScreenshot = $null

while ($true) {
    $iteration++
    
    # Clear screen every 5 iterations
    if ($iteration % 5 -eq 0) {
        Clear-Host
        Write-Host "=== Worker Progress Monitor (Update #$iteration) ===" -ForegroundColor Cyan
        Write-Host ""
    }
    
    # Get status
    $browserStatus = Get-BrowserStatus
    $screenshot = Get-LatestScreenshot
    
    # Display status
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Status Update" -ForegroundColor Green
    Write-Host "  Browser: $browserStatus"
    Write-Host ""
    
    # Check for new screenshot
    if ($screenshot -and ($screenshot.Name -ne $lastScreenshot)) {
        Write-Host "[SCREENSHOT] New: $($screenshot.Name)" -ForegroundColor Magenta
        Write-Host "             Time: $($screenshot.LastWriteTime.ToString('HH:mm:ss'))"
        $lastScreenshot = $screenshot.Name
        Write-Host ""
    }
    
    # Show recent console output (try to capture from running node process)
    Write-Host "[ACTIVITY] Checking for updates..." -ForegroundColor Cyan
    
    # Check log files
    $logFiles = @("worker.log", "worker_debug.log", "prepare.log")
    $foundLogs = $false
    
    foreach ($logFile in $logFiles) {
        if (Test-Path $logFile) {
            $logs = Get-FileTail -Path $logFile -Lines 3
            if ($logs) {
                Write-Host "  From $logFile" ":" -ForegroundColor Gray
                foreach ($log in $logs) {
                    if ($log -like "*Step*" -or $log -like "*2SV*" -or $log -like "*2FA*" -or $log -like "*DWD*") {
                        Write-Host "    > $log" -ForegroundColor Yellow
                        $foundLogs = $true
                    }
                }
            }
        }
    }
    
    if (-not $foundLogs) {
        Write-Host "  No recent activity in log files" -ForegroundColor Gray
    }
    
    Write-Host ""
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host ""
    
    # Wait before next check
    Start-Sleep -Seconds 5
}
