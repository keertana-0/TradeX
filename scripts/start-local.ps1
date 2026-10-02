$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot 'runtime-logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Test-LocalPort([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1)
}

if (-not (Test-LocalPort 5433)) {
  $nodePath = (Get-Command node.exe).Source
  Start-Process -FilePath $nodePath -ArgumentList 'scripts/start-embedded-pg.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'postgres.log') -RedirectStandardError (Join-Path $logDir 'postgres-error.log') | Out-Null
  $databaseReady = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 2
    if (Test-LocalPort 5433) { $databaseReady = $true; break }
  }
  if (-not $databaseReady) { throw "TradeX PostgreSQL did not start on port 5433. Check $logDir\postgres-error.log." }
}

Push-Location $projectRoot
try {
  & npm.cmd run db:push
  if ($LASTEXITCODE -ne 0) { throw 'Prisma could not sync the TradeX database schema.' }

  if (-not (Test-LocalPort 3000)) {
    $npmPath = (Get-Command npm.cmd).Source
    Start-Process -FilePath $npmPath -ArgumentList @('run','dev','--','--hostname','127.0.0.1','--port','3000') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'next.log') -RedirectStandardError (Join-Path $logDir 'next-error.log') | Out-Null
  }
} finally { Pop-Location }

$appReady = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Seconds 2
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/login' -TimeoutSec 3 -UseBasicParsing
    if ($response.StatusCode -eq 200) { $appReady = $true; break }
  } catch {}
}
if (-not $appReady) { throw "TradeX web app did not become ready on port 3000. Check $logDir\next-error.log." }

if ([string]::IsNullOrWhiteSpace($env:UPSTOX_ACCESS_TOKEN)) {
  $envLines = if (Test-Path (Join-Path $projectRoot '.env')) { Get-Content (Join-Path $projectRoot '.env') } else { @() }
  $hasToken = [bool]($envLines | Where-Object { $_ -match '^\s*UPSTOX_ACCESS_TOKEN\s*=\s*\S+' })
  if (-not $hasToken) { Write-Warning 'UPSTOX_ACCESS_TOKEN is not configured. App and database are ready, but option entries will wait for live Upstox data.' }
}

Start-Process 'http://127.0.0.1:3000/login'
Write-Host 'TradeX is ready at http://127.0.0.1:3000/login'
