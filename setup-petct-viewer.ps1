# ============================================================
# setup-petct-viewer.ps1
# PET-CT Viewer — One-command setup & launch
# Node 24 + npm 11 + Cornerstone3D v2.1.16 + Orthanc v1.12.10
# Run from: D:\PET-CT Viewer\petct-viewer\
# Usage: .\setup-petct-viewer.ps1
# ============================================================

param(
    [switch]$SkipInstall,   # Skip npm install (if already done)
    [switch]$SkipOrthanc,   # Skip Orthanc start (if already running)
    [switch]$ClearCache     # Force clear Vite cache before start
)

$ProjectDir = "D:\PET-CT Viewer\petct-viewer"
$PublicDir  = "$ProjectDir\public"
$SrcDir     = "$ProjectDir\src"

Write-Host ""
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "  PET-CT VIEWER — Setup & Launch" -ForegroundColor Cyan
Write-Host "=================================================" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check we're in the right directory ──────────────────────────────
if (-not (Test-Path "$ProjectDir\package.json")) {
    Write-Host "ERROR: Cannot find package.json in $ProjectDir" -ForegroundColor Red
    Write-Host "Please run this script from the correct directory." -ForegroundColor Red
    exit 1
}
Set-Location $ProjectDir
Write-Host "[1/6] Working directory: $ProjectDir" -ForegroundColor Green

# ── Step 2: Check Node version ───────────────────────────────────────────────
$nodeVer = (node --version 2>&1).ToString().TrimStart('v')
$nodeMaj = [int]($nodeVer.Split('.')[0])
if ($nodeMaj -lt 18) {
    Write-Host "ERROR: Node.js $nodeVer found. Need v18 or higher." -ForegroundColor Red
    exit 1
}
Write-Host "[2/6] Node.js v$nodeVer OK" -ForegroundColor Green

# ── Step 3: npm install ───────────────────────────────────────────────────────
if (-not $SkipInstall) {
    if (-not (Test-Path "$ProjectDir\node_modules")) {
        Write-Host "[3/6] node_modules not found — running npm install..." -ForegroundColor Yellow
        npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host "ERROR: npm install failed." -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "[3/6] node_modules found — skipping install (use -SkipInstall:$false to force)" -ForegroundColor Green
    }
} else {
    Write-Host "[3/6] Skipping npm install (-SkipInstall flag set)" -ForegroundColor DarkGray
}

# ── Step 4: Copy WASM codec files to public\ ────────────────────────────────
Write-Host "[4/6] Checking WASM codec files in public\..." -ForegroundColor Yellow

$codecs = @(
    "codec-charls",
    "codec-libjpeg-turbo-8bit",
    "codec-openjpeg",
    "codec-openjph"
)

$missingWasm = $false
foreach ($codec in $codecs) {
    $srcPath = "$ProjectDir\node_modules\@cornerstonejs\$codec\dist"
    if (Test-Path $srcPath) {
        $files = Get-ChildItem "$srcPath\*" -Include "*.wasm","*.js" -ErrorAction SilentlyContinue
        foreach ($f in $files) {
            $dest = "$PublicDir\$($f.Name)"
            if (-not (Test-Path $dest)) {
                Copy-Item $f.FullName $PublicDir -Force
                Write-Host "    Copied: $($f.Name)" -ForegroundColor DarkGray
                $missingWasm = $true
            }
        }
    }
}
if (-not $missingWasm) {
    Write-Host "    All WASM codec files present." -ForegroundColor Green
} else {
    Write-Host "    WASM files copied to public\" -ForegroundColor Green
}
Write-Host "[4/6] WASM codecs OK" -ForegroundColor Green

# ── Step 5: Start Orthanc ────────────────────────────────────────────────────
if (-not $SkipOrthanc) {
    Write-Host "[5/6] Checking Orthanc..." -ForegroundColor Yellow
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8042/system" -TimeoutSec 3 -ErrorAction Stop
        Write-Host "[5/6] Orthanc already running on port 8042 OK" -ForegroundColor Green
    } catch {
        Write-Host "    Orthanc not responding — attempting to start service..." -ForegroundColor Yellow
        try {
            # Try common service names
            $serviceNames = @("Orthanc", "orthanc", "OrthancServer")
            $started = $false
            foreach ($svc in $serviceNames) {
                $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
                if ($s) {
                    if ($s.Status -ne "Running") {
                        Start-Service $svc
                        Start-Sleep -Seconds 3
                    }
                    $started = $true
                    Write-Host "[5/6] Orthanc service '$svc' started OK" -ForegroundColor Green
                    break
                }
            }
            if (-not $started) {
                Write-Host "WARNING: Could not find Orthanc service." -ForegroundColor Yellow
                Write-Host "         Start Orthanc manually, then retry." -ForegroundColor Yellow
                Write-Host "         Or add -SkipOrthanc flag to continue anyway." -ForegroundColor Yellow
            }
        } catch {
            Write-Host "WARNING: Could not start Orthanc: $_" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host "[5/6] Skipping Orthanc check (-SkipOrthanc flag set)" -ForegroundColor DarkGray
}

# ── Step 6: Clear Vite cache if needed and start dev server ─────────────────
Write-Host "[6/6] Starting Vite dev server..." -ForegroundColor Yellow

if ($ClearCache -or -not (Test-Path "$ProjectDir\node_modules\.vite")) {
    $viteCacheDir = "$ProjectDir\node_modules\.vite"
    if (Test-Path $viteCacheDir) {
        Remove-Item -Recurse -Force $viteCacheDir
        Write-Host "    Cleared Vite cache." -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host "  Launching at: http://localhost:5173" -ForegroundColor Cyan
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Cyan
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host ""
    Start-Sleep -Seconds 1
    Start-Process "chrome.exe" -ArgumentList "http://localhost:5173" -ErrorAction SilentlyContinue
    npm run dev -- --force
} else {
    Write-Host ""
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host "  Launching at: http://localhost:5173" -ForegroundColor Cyan
    Write-Host "  Press Ctrl+C to stop" -ForegroundColor Cyan
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host ""
    Start-Sleep -Seconds 1
    Start-Process "chrome.exe" -ArgumentList "http://localhost:5173" -ErrorAction SilentlyContinue
    npm run dev
}
