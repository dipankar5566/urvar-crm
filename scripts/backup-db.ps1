<#
.SYNOPSIS
  Nightly pg_dump of the urvar_crm Postgres database (Phase 0 of the
  sales-funnel automation roadmap — see C:\Users\ADMIN\.claude\plans\all.md).

.DESCRIPTION
  Reads DATABASE_URL out of .env (never hardcodes credentials), locates
  pg_dump.exe, and writes a timestamped custom-format dump (restorable via
  pg_restore / restore-db.ps1) to BACKUP_DIR, then prunes dumps older than
  BACKUP_RETENTION_DAYS. Intended to run once daily via a Windows Scheduled
  Task (see register-backup-task.ps1) — this script does not schedule
  itself.

  A failed/missing pg_dump.exe exits non-zero with a specific error rather
  than silently doing nothing: Task Scheduler's "Last Run Result" and this
  script's own log are the only signals anyone will see, so silence here
  would look identical to success.
#>

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $RepoRoot ".env"

function Read-EnvVar {
    param([string]$Name, [string]$Path)
    if (-not (Test-Path $Path)) {
        throw "Cannot find .env at $Path"
    }
    $line = Get-Content $Path | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
    if (-not $line) {
        throw ".env has no $Name entry"
    }
    # Values are always double-quoted in this repo's .env — strip the quotes.
    return ($line -replace "^\s*$Name\s*=\s*`"?([^`"]*)`"?\s*$", '$1')
}

$databaseUrl = Read-EnvVar -Name "DATABASE_URL" -Path $EnvFile
$backupDir = Read-EnvVar -Name "BACKUP_DIR" -Path $EnvFile
$retentionDays = [int](Read-EnvVar -Name "BACKUP_RETENTION_DAYS" -Path $EnvFile)

# postgresql://user:pass@host:port/db?schema=public
if ($databaseUrl -notmatch '^postgresql://(?<user>[^:]+):(?<pass>[^@]+)@(?<host>[^:/]+):(?<port>\d+)/(?<db>[^?]+)') {
    throw "DATABASE_URL in .env did not match the expected postgresql://user:pass@host:port/db shape"
}
$dbUser = $Matches.user
$dbPass = $Matches.pass
$dbHost = $Matches.host
$dbPort = $Matches.port
$dbName = $Matches.db

$pgDumpCandidates = @(
    "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe"
)
$pgDump = $pgDumpCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $pgDump) {
    $found = Get-Command pg_dump.exe -ErrorAction SilentlyContinue
    if ($found) { $pgDump = $found.Source }
}
if (-not $pgDump) {
    throw "pg_dump.exe not found at the standard PostgreSQL 18 install path or on PATH. Backup did NOT run."
}

if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
}

$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$dumpFile = Join-Path $backupDir "urvar_crm_$timestamp.dump"
$logFile = Join-Path $backupDir "backup-log.txt"

function Write-Log {
    param([string]$Message)
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Add-Content -Path $logFile -Value $line
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$env:PGPASSWORD = $dbPass
try {
    & $pgDump -h $dbHost -p $dbPort -U $dbUser -Fc -f $dumpFile $dbName
    $exitCode = $LASTEXITCODE
} finally {
    # Scoped to this process only — never passed as a CLI arg, which Task
    # Scheduler history and `wmic process get commandline` could expose.
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
$sw.Stop()

if ($exitCode -ne 0) {
    Write-Log "FAILED host=$dbHost db=$dbName file=$dumpFile durationMs=$($sw.ElapsedMilliseconds) exitCode=$exitCode"
    if (Test-Path $dumpFile) { Remove-Item $dumpFile -Force -ErrorAction SilentlyContinue }
    throw "pg_dump exited with code $exitCode"
}

Write-Log "OK host=$dbHost db=$dbName file=$dumpFile durationMs=$($sw.ElapsedMilliseconds)"

# Retention: prune dumps older than $retentionDays.
$cutoff = (Get-Date).AddDays(-$retentionDays)
Get-ChildItem -Path $backupDir -Filter "urvar_crm_*.dump" |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
        Remove-Item $_.FullName -Force
        Write-Log "Pruned old backup: $($_.Name)"
    }

exit 0
