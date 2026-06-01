# Worker Progress Monitor
# This script monitors the worker progress in real-time

Write-Host "🔍 Worker Progress Monitor" -ForegroundColor Cyan
Write-Host "=" * 60 -ForegroundColor Cyan
Write-Host ""

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

# Function to check browser status
function Get-BrowserStatus {
    $chrome = Get-Process chrome -ErrorAction SilentlyContinue
    if ($chrome) {
        return "✅ Running ($($chrome.Count) processes)"
    }
    return "❌ Not running"
}

# Function to check worker processes
function Get-WorkerStatus {
    $workers = Get-Process node -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -like "*dist/index.js worker*"
    }
    
    if ($workers) {
        return "✅ Running ($($workers.Count) workers)"
    }
    return "❌ Not running"
}

# Function to get latest log entries
function Get-LatestLogs {
    param([int]$Lines = 10)
    
    # Try to read from console output or log files
    $logFiles = @("worker.log", "worker_debug.log", "prepare.log")
    
    foreach ($logFile in $logFiles) {
        if (Test-Path $logFile) {
            $content = Get-Content $logFile -Tail $Lines -ErrorAction SilentlyContinue
            if ($content) {
                return $content
            }
        }
    }
    
    return @("No logs found")
}

# Function to parse step from logs
function Get-CurrentStep {
    $logs = Get-LatestLogs -Lines 50
    
    $stepPatterns = @{
        "Step 0:"      = "🔐 Authentication"
        "Step 1:"      = "📦 Creating Project"
        "Step 2:"      = "🔌 Enabling APIs"
        "Step 3:"      = "👤 Creating Service Account"
        "Step 4:"      = "🏢 Configuring Org Policies"
        "Step 5:"      = "🔑 Generating Key"
        "Step 6:"      = "☁️ Uploading to S3"
        "Step 7:"      = "🔗 Domain-Wide Delegation"
        "Step 8:"      = "🔐 Setting up 2FA"
        "Step 9:"      = "💾 Backing up Secret Key"
        "Step 10:"     = "⚙️ Configuring 2SV Policy"
        "[2SV Policy]" = "⚙️ 2SV Configuration"
        "[2FA]"        = "🔐 2FA Setup"
        "[DWD]"        = "🔗 DWD Configuration"
        "gcloud Auth"  = "🔐 GCloud Authentication"
    }
    
    foreach ($log in $logs) {
        foreach ($pattern in $stepPatterns.Keys) {
            if ($log -like "*$pattern*") {
                return "$($stepPatterns[$pattern]) - $log"
            }
        }
    }
    
    return "⏳ Waiting for job..."
}

# Monitor loop
$iteration = 0
$lastScreenshot = $null

Write-Host "Starting monitor... Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

while ($true) {
    $iteration++
    
    # Clear screen every 10 iterations
    if ($iteration % 10 -eq 0) {
        Clear-Host
        Write-Host "🔍 Worker Progress Monitor (Iteration $iteration)" -ForegroundColor Cyan
        Write-Host "=" * 60 -ForegroundColor Cyan
        Write-Host ""
    }
    
    # Get status
    $browserStatus = Get-BrowserStatus
    $workerStatus = Get-WorkerStatus
    $currentStep = Get-CurrentStep
    $screenshot = Get-LatestScreenshot
    
    # Display status
    Write-Host "📊 Status Update - $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Green
    Write-Host "  Browser: $browserStatus"
    Write-Host "  Worker:  $workerStatus"
    Write-Host ""
    Write-Host "📍 Current Step:" -ForegroundColor Yellow
    Write-Host "  $currentStep"
    Write-Host ""
    
    # Check for new screenshot
    if ($screenshot -and ($screenshot.Name -ne $lastScreenshot)) {
        Write-Host "📸 New Screenshot: $($screenshot.Name)" -ForegroundColor Magenta
        Write-Host "   Time: $($screenshot.LastWriteTime.ToString('HH:mm:ss'))"
        Write-Host "   Size: $([math]::Round($screenshot.Length/1KB, 2)) KB"
        $lastScreenshot = $screenshot.Name
        Write-Host ""
    }
    
    # Show recent logs
    Write-Host "📝 Recent Activity:" -ForegroundColor Cyan
    $recentLogs = Get-LatestLogs -Lines 5
    foreach ($log in $recentLogs) {
        $logClean = $log -replace '\[INF\]|\[ERR\]|\[DBG\]', ''
        if ($log -like "*ERR*") {
            Write-Host "  ❌ $logClean" -ForegroundColor Red
        }
        elseif ($log -like "*✅*" -or $log -like "*success*") {
            Write-Host "  ✅ $logClean" -ForegroundColor Green
        }
        else {
            Write-Host "  ℹ️  $logClean" -ForegroundColor Gray
        }
    }
    
    Write-Host ""
    Write-Host ("-" * 60) -ForegroundColor DarkGray
    Write-Host ""
    
    # Wait before next check
    Start-Sleep -Seconds 5
}
