#Requires -Version 5.1
<#
.SYNOPSIS
  Register a daily Windows Scheduled Task for R2 token sync.

.DESCRIPTION
  Runs sync-tokens-local.ps1 daily at 23:00 Pacific (≈ 06:00 UTC).
  Requires R2/.env with CLOUDFLARE_API_TOKEN or R2 S3 keys.
#>
param(
  [string]$TaskName = 'TTS-Card-Importer-R2-Token-Sync',
  [string]$TimeLocal = '23:00'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $PSScriptRoot 'sync-tokens-local.ps1'
$EnvFile = Join-Path $Root '.env'

if (-not (Test-Path $Runner)) { throw "Missing $Runner" }
if (-not (Test-Path $EnvFile)) {
  throw "Missing $EnvFile - copy .env.example to .env and set CLOUDFLARE_API_TOKEN first."
}

$arg = "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -Daily -At $TimeLocal
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Force | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host "  Daily at $TimeLocal (local time)"
Write-Host "  Script: $Runner"
Write-Host "  WorkingDirectory: $Root"
Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo | Format-List TaskName, LastRunTime, NextRunTime, LastTaskResult
