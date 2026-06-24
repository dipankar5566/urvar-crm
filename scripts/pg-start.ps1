# Starts the portable PostgreSQL instance used by Urvar CRM.
# The DB lives outside the repo at D:\PostgresPortable (binaries + data).
$ErrorActionPreference = "Stop"
$PG = "D:\PostgresPortable\pgsql\bin"
$DATA = "D:\PostgresPortable\data"

if (-not (Test-Path "$PG\pg_ctl.exe")) {
  Write-Error "PostgreSQL binaries not found at $PG. See README for setup."
  exit 1
}

$status = & "$PG\pg_ctl.exe" -D $DATA status 2>&1
if ($status -match "server is running") {
  Write-Host "PostgreSQL already running." -ForegroundColor Green
} else {
  & "$PG\pg_ctl.exe" -D $DATA -l "D:\PostgresPortable\server.log" -o "-p 5432" start
  Write-Host "PostgreSQL started on port 5432." -ForegroundColor Green
}
