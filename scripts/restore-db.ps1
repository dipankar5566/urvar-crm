<#
.SYNOPSIS
  Restores a urvar_crm pg_dump (see backup-db.ps1) into a Postgres database
  — Phase 0 of the sales-funnel automation roadmap.

.DESCRIPTION
  Defaults to a disposable target database (urvar_crm_restore_test), never
  the live urvar_crm, so running this script by habit or by mistake cannot
  clobber production. Restoring onto the real urvar_crm requires explicitly
  passing -TargetDb urvar_crm plus typing the name again to confirm.

  Note: creating a new database requires the connecting role to have
  CREATEDB. Per CLAUDE.md, the app's own DB user (urvar_app, read out of
  .env the same way backup-db.ps1 does) may not have this — if CREATE
  DATABASE fails here, re-run against the `postgres` superuser role instead
  (pass -AdminUser/-AdminPassword). Whether this is actually necessary on
  this box is an open question in the Phase 0 plan, not assumed either way.

.PARAMETER DumpFile
  Path to a .dump file. Defaults to the most recent file in BACKUP_DIR.

.PARAMETER TargetDb
  Database to restore into. Defaults to urvar_crm_restore_test.

.PARAMETER AdminUser / AdminPassword
  Optional: role used only for the CREATE DATABASE step, if the app's own
  DB user lacks CREATEDB. The actual pg_restore always runs as the app's
  own DB user (from .env), matching normal operation.
#>

param(
    [string]$DumpFile,
    [string]$TargetDb = "urvar_crm_restore_test",
    [string]$AdminUser,
    [string]$AdminPassword
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $RepoRoot ".env"

function Read-EnvVar {
    param([string]$Name, [string]$Path)
    $line = Get-Content $Path | Where-Object { $_ -match "^\s*$Name\s*=" } | Select-Object -First 1
    if (-not $line) { throw ".env has no $Name entry" }
    return ($line -replace "^\s*$Name\s*=\s*`"?([^`"]*)`"?\s*$", '$1')
}

$databaseUrl = Read-EnvVar -Name "DATABASE_URL" -Path $EnvFile
$backupDir = Read-EnvVar -Name "BACKUP_DIR" -Path $EnvFile

if ($databaseUrl -notmatch '^postgresql://(?<user>[^:]+):(?<pass>[^@]+)@(?<host>[^:/]+):(?<port>\d+)/') {
    throw "DATABASE_URL in .env did not match the expected postgresql://user:pass@host:port/db shape"
}
$dbUser = $Matches.user
$dbPass = $Matches.pass
$dbHost = $Matches.host
$dbPort = $Matches.port

if (-not $DumpFile) {
    $latest = Get-ChildItem -Path $backupDir -Filter "urvar_crm_*.dump" |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { throw "No dump files found in $backupDir and -DumpFile was not given." }
    $DumpFile = $latest.FullName
}
if (-not (Test-Path $DumpFile)) { throw "Dump file not found: $DumpFile" }

$binDir = "C:\Program Files\PostgreSQL\18\bin"
$psql = Join-Path $binDir "psql.exe"
$pgRestore = Join-Path $binDir "pg_restore.exe"
if (-not (Test-Path $psql)) { $psql = (Get-Command psql.exe -ErrorAction Stop).Source }
if (-not (Test-Path $pgRestore)) { $pgRestore = (Get-Command pg_restore.exe -ErrorAction Stop).Source }

if ($TargetDb -eq "urvar_crm") {
    Write-Host "WARNING: -TargetDb is the live production database (urvar_crm)." -ForegroundColor Yellow
    $confirm = Read-Host "Type the database name again to confirm you intend to overwrite it"
    if ($confirm -ne "urvar_crm") { throw "Confirmation did not match. Aborting." }
}

# Create the target DB if it doesn't already exist.
$createUser = if ($AdminUser) { $AdminUser } else { $dbUser }
$createPass = if ($AdminPassword) { $AdminPassword } else { $dbPass }
$env:PGPASSWORD = $createPass
try {
    $exists = & $psql -h $dbHost -p $dbPort -U $createUser -tAc "SELECT 1 FROM pg_database WHERE datname = '$TargetDb'" postgres
    if ($exists -ne "1") {
        Write-Host "Creating database $TargetDb ..."
        & $psql -h $dbHost -p $dbPort -U $createUser -c "CREATE DATABASE `"$TargetDb`"" postgres
        if ($LASTEXITCODE -ne 0) {
            throw "CREATE DATABASE failed as role '$createUser'. If this role lacks CREATEDB, re-run with -AdminUser/-AdminPassword for a role that has it (e.g. the postgres superuser)."
        }
    }
    if ($createUser -ne $dbUser) {
        # PostgreSQL 15+ locks CREATE on the public schema to the database
        # owner only. The admin role owns a freshly-created database, so the
        # app's own DB user (who runs the actual pg_restore below, matching
        # normal operation) would otherwise get "permission denied for
        # schema public" on every single object. Idempotent — safe whether
        # the database was just created or already existed.
        Write-Host "Granting schema public privileges to $dbUser on $TargetDb ..."
        & $psql -h $dbHost -p $dbPort -U $createUser -c "GRANT ALL ON SCHEMA public TO `"$dbUser`"" $TargetDb
        if ($LASTEXITCODE -ne 0) {
            throw "GRANT ALL ON SCHEMA public failed as role '$createUser' on $TargetDb."
        }
    }
} finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

# Restore always runs as the app's own DB user, matching normal operation.
$env:PGPASSWORD = $dbPass
try {
    Write-Host "Restoring $DumpFile into $TargetDb ..."
    & $pgRestore -h $dbHost -p $dbPort -U $dbUser -d $TargetDb --clean --if-exists $DumpFile
    $restoreExit = $LASTEXITCODE
} finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
# pg_restore can exit non-zero on harmless warnings (e.g. "role does not
# exist" for ownership it can't reassign in a differently-provisioned target
# DB) — treat it as informational and proceed to the sanity check rather
# than failing the whole restore on that alone.
if ($restoreExit -ne 0) {
    Write-Host "pg_restore exited with code $restoreExit (may include non-fatal warnings - see output above)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Post-restore sanity check (row counts):"
$env:PGPASSWORD = $dbPass
try {
    foreach ($table in @("Lead", "Customer", "Quotation")) {
        # A -c "..." argument with an embedded, backtick-escaped double quote
        # (for the case-sensitive "Lead" identifier) gets silently stripped
        # somewhere in PowerShell's native-exe argument passing — confirmed
        # live (psql received the unquoted, lowercase-folded `Lead`, not
        # `"Lead"`). A real temp .sql file sidesteps that entirely: no
        # embedded quotes ever need to survive PowerShell-to-argv encoding.
        $tmpSql = [System.IO.Path]::GetTempFileName()
        Set-Content -Path $tmpSql -Value "SELECT count(*) FROM `"$table`";" -NoNewline
        $count = & $psql -h $dbHost -p $dbPort -U $dbUser -tA -f $tmpSql $TargetDb
        Remove-Item $tmpSql -ErrorAction SilentlyContinue
        Write-Host ("  {0,-12} {1}" -f $table, $count.Trim())
    }
} finally {
    Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}
