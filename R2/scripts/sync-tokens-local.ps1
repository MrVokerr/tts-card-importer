#Requires -Version 5.1
<#
.SYNOPSIS
  Local daily R2 token sync (no GitHub Actions).

.DESCRIPTION
  Loads R2/.env, runs node scripts/sync-tokens.js, appends a log under R2/logs/.
  Prefer this over GitHub Actions - same publish path, no Actions conclusion/API flake.

.PARAMETER Force
  Pass --force to rebuild even when Scryfall bulk updatedAt is unchanged.

.PARAMETER DryRun
  Pass --dry-run (build + guards only; no R2 writes).
#>
param(
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root '.env'
$LogDir = Join-Path $Root 'logs'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$LogFile = Join-Path $LogDir "token-sync-$Stamp.log"

function Write-Log([string]$Message) {
  $line = "{0} {1}" -f (Get-Date -Format 'o'), $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $EnvFile)) {
  throw "Missing $EnvFile - copy .env.example to .env and fill CLOUDFLARE_API_TOKEN (or R2 S3 keys)."
}

Get-Content $EnvFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $i = $line.IndexOf('=')
  if ($i -lt 1) { return }
  $name = $line.Substring(0, $i).Trim()
  $value = $line.Substring($i + 1).Trim()
  if (
    ($value.StartsWith('"') -and $value.EndsWith('"')) -or
    ($value.StartsWith("'") -and $value.EndsWith("'"))
  ) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  Set-Item -Path "Env:$name" -Value $value
}

if (-not $env:R2_ACCOUNT_ID) { throw 'R2_ACCOUNT_ID missing in .env' }
if (-not $env:R2_BUCKET) { throw 'R2_BUCKET missing in .env' }
if (-not $env:R2_PUBLIC_BASE_URL) {
  $env:R2_PUBLIC_BASE_URL = 'https://pub-6c935b50ab2c43f291df08b7f566585b.r2.dev'
}
$hasS3 = $env:R2_ACCESS_KEY_ID -and $env:R2_SECRET_ACCESS_KEY
$hasCf = [bool]$env:CLOUDFLARE_API_TOKEN
if (-not $hasS3 -and -not $hasCf) {
  throw 'Set CLOUDFLARE_API_TOKEN or R2_ACCESS_KEY_ID+R2_SECRET_ACCESS_KEY in .env'
}

Push-Location $Root
try {
  Write-Log "Starting token sync (Force=$Force DryRun=$DryRun)"
  if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Log 'npm ci'
    npm ci 2>&1 | Tee-Object -FilePath $LogFile -Append | Out-Host
  }

  $args = @()
  if ($Force) { $args += '--force' }
  if ($DryRun) { $args += '--dry-run' }

  Write-Log ("node scripts/sync-tokens.js " + ($args -join ' '))
  & node scripts/sync-tokens.js @args 2>&1 | Tee-Object -FilePath $LogFile -Append | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "sync-tokens.js exited $LASTEXITCODE"
  }
  Write-Log 'Token sync OK'
  exit 0
} catch {
  Write-Log ("FAILED: " + $_.Exception.Message)
  exit 1
} finally {
  Pop-Location
}
