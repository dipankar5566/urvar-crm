<#
.SYNOPSIS
  One-off registration of the daily urvar_crm backup as a Windows Scheduled
  Task — Phase 0 of the sales-funnel automation roadmap. Run this script
  interactively, once; it does not schedule itself.

.DESCRIPTION
  Registers "UrvarCrmDbBackup" to run backup-db.ps1 daily at 02:00, under
  the account running this registration script (interactive-only trigger —
  no stored password, so this normally does not require elevation). If this
  box is ever logged off overnight, the task will not fire; in that case,
  re-register with "Run whether user is logged in or not" instead, which
  does require an elevated schtasks call with a stored credential — decide
  which applies to this box before relying on the schedule.
#>

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ScriptPath = Join-Path $RepoRoot "scripts\backup-db.ps1"

if (-not (Test-Path $ScriptPath)) {
    throw "Cannot find $ScriptPath"
}

$taskName = "UrvarCrmDbBackup"
$action = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""

Write-Host "Registering scheduled task '$taskName' to run daily at 02:00..."
schtasks /create /tn $taskName /tr $action /sc daily /st 02:00 /rl LIMITED /f

if ($LASTEXITCODE -ne 0) {
    throw "schtasks /create failed with exit code $LASTEXITCODE"
}

Write-Host "Registered. Verify with: schtasks /query /tn `"$taskName`" /v /fo list"
Write-Host "Run it once manually to confirm it works: schtasks /run /tn `"$taskName`""
