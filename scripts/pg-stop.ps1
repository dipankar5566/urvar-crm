# Stops the portable PostgreSQL instance used by Urvar CRM.
$PG = "D:\PostgresPortable\pgsql\bin"
$DATA = "D:\PostgresPortable\data"
& "$PG\pg_ctl.exe" -D $DATA -m fast stop
Write-Host "PostgreSQL stopped." -ForegroundColor Yellow
