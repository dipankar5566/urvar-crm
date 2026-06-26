# One-time production cutover for Urvar CRM on this machine: Cloudflare Tunnel,
# Postgres as a Windows service (NSSM), the app under PM2, and a nightly backup task.
# Idempotent - safe to re-run if interrupted. Must be run from an elevated
# ("Run as Administrator") PowerShell window, since it registers Windows services.

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$isAdmin = ([Security.Principal.WindowsIdentity]::GetCurrent()).Groups -contains "S-1-5-32-544"
if (-not $isAdmin) {
  Write-Error "Not running elevated. Right-click PowerShell -> 'Run as Administrator', then re-run this script."
  exit 1
}

function Section($name) {
  Write-Host "`n==> $name" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
Section "Cloudflare Tunnel: install cloudflared"
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
} else {
  Write-Host "cloudflared already installed."
}

Section "Cloudflare Tunnel: login"
$cloudflaredDir = "$env:USERPROFILE\.cloudflared"
$certPath = "$cloudflaredDir\cert.pem"
if (-not (Test-Path $certPath)) {
  Write-Host "Opening browser - log in and authorize the urvarindia.com zone, then return here." -ForegroundColor Yellow
  cloudflared tunnel login
} else {
  Write-Host "Already authenticated (cert.pem present)."
}

Section "Cloudflare Tunnel: create tunnel 'urvar-crm'"
$tunnelListJson = cloudflared tunnel list --output json
$tunnelList = @()
if ($tunnelListJson) { $tunnelList = $tunnelListJson | ConvertFrom-Json }
$tunnel = $tunnelList | Where-Object { $_.name -eq "urvar-crm" } | Select-Object -First 1
if (-not $tunnel) {
  cloudflared tunnel create urvar-crm
  $tunnelListJson = cloudflared tunnel list --output json
  $tunnel = ($tunnelListJson | ConvertFrom-Json) | Where-Object { $_.name -eq "urvar-crm" } | Select-Object -First 1
}
$tunnelId = $tunnel.id
Write-Host "Tunnel id: $tunnelId"

Section "Cloudflare Tunnel: write config.yml"
$credFile = "$cloudflaredDir\$tunnelId.json"
$configPath = "$cloudflaredDir\config.yml"
@"
tunnel: $tunnelId
credentials-file: $credFile

ingress:
  - hostname: crm.urvarindia.com
    service: http://localhost:3000
  - service: http_status:404
"@ | Set-Content -Path $configPath -Encoding utf8

Section "Cloudflare Tunnel: route DNS"
cloudflared tunnel route dns urvar-crm crm.urvarindia.com

Section "Cloudflare Tunnel: install as Windows service"
# The service runs as LocalSystem, whose profile is NOT $env:USERPROFILE, so it
# won't find config.yml under C:\Users\<you>\.cloudflared by default. Neither
# `cloudflared service install` nor `sc.exe config` reliably persist a custom
# --config path on this cloudflared build, so install first (creates the
# service with a default, configless binary path), then patch the registry
# ImagePath directly with the correct command line - that's the one method
# that reliably sticks.
$cloudflaredExe = (Get-Command cloudflared).Source
$correctImagePath = "`"$cloudflaredExe`" --config `"$configPath`" tunnel run"
if (-not (Get-Service Cloudflared -ErrorAction SilentlyContinue)) {
  cloudflared service install
  Start-Sleep -Seconds 2
}
$regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared"
$currentImagePath = (Get-ItemProperty -Path $regPath -Name ImagePath).ImagePath
if ($currentImagePath -ne $correctImagePath) {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
  Set-ItemProperty -Path $regPath -Name ImagePath -Value $correctImagePath
}
Start-Service Cloudflared -ErrorAction SilentlyContinue
Get-Service Cloudflared | Select-Object Name, Status

Section "Stop temporary ngrok tunnel (no longer needed)"
Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force

# ---------------------------------------------------------------------------
Section "Postgres: register as Windows service (pg_ctl's built-in registration, no third-party tool needed)"
$pgBin = "D:\PostgresPortable\pgsql\bin"
$pgData = "D:\PostgresPortable\data"
if (-not (Get-Service UrvarCrmPostgres -ErrorAction SilentlyContinue)) {
  # Stop any manually-started instance first so the service can bind port 5432.
  & "$pgBin\pg_ctl.exe" -D $pgData -m fast stop

  & "$pgBin\pg_ctl.exe" register -N UrvarCrmPostgres -D $pgData -S auto -o "-p 5432"
  sc.exe failure UrvarCrmPostgres reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
  Start-Service UrvarCrmPostgres
} else {
  Write-Host "UrvarCrmPostgres service already registered."
  Start-Service UrvarCrmPostgres -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Get-Service UrvarCrmPostgres | Select-Object Name, Status

# ---------------------------------------------------------------------------
Section "Backups: nightly pg_dump scheduled task"
$backupScript = "D:\PostgresPortable\backup-pg.ps1"
@'
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDir = "E:\UrvarCrmBackups"
if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
$out = Join-Path $backupDir "urvar_crm_$ts.dump"
$env:PGPASSWORD = "postgres"
& "D:\PostgresPortable\pgsql\bin\pg_dump.exe" -h localhost -p 5432 -U postgres -F c -f $out urvar_crm
Remove-Item Env:\PGPASSWORD
Get-ChildItem $backupDir -Filter *.dump | Sort-Object LastWriteTime -Descending | Select-Object -Skip 14 | Remove-Item
'@ | Set-Content -Path $backupScript -Encoding utf8

if (-not (Get-ScheduledTask -TaskName "UrvarCrmPgBackup" -ErrorAction SilentlyContinue)) {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$backupScript`""
  $trigger = New-ScheduledTaskTrigger -Daily -At 2am
  Register-ScheduledTask -TaskName "UrvarCrmPgBackup" -Action $action -Trigger $trigger -RunLevel Highest | Out-Null
  Write-Host "Scheduled task 'UrvarCrmPgBackup' created (daily 2 AM)."
} else {
  Write-Host "Scheduled task 'UrvarCrmPgBackup' already exists."
}

# ---------------------------------------------------------------------------
Section "App: install as a Windows service via WinSW"
# PM2's Windows story only resurrects at user logon (a registry Run-key), not
# at boot - so the app would stay down after an unattended reboot until
# someone logs in. WinSW wraps it as a real service instead, like Postgres
# and Cloudflared. NSSM would normally do this but nssm.cc's download server
# was down when this was set up; WinSW (GitHub-hosted) is the same idea.
$svcDir = "D:\Urvar-CRM-service"
$svcExe = "$svcDir\UrvarCrmApp.exe"
if (-not (Test-Path $svcDir)) { New-Item -ItemType Directory -Path $svcDir | Out-Null }
if (-not (Test-Path $svcExe)) {
  Invoke-WebRequest -Uri "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe" -OutFile $svcExe
}
$nodeExe = (Get-Command node).Source
@"
<service>
  <id>UrvarCrmApp</id>
  <name>Urvar CRM App</name>
  <description>Urvar CRM Next.js production server (next start)</description>
  <executable>$nodeExe</executable>
  <arguments>node_modules\next\dist\bin\next start</arguments>
  <workingdirectory>$RepoRoot</workingdirectory>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
</service>
"@ | Set-Content -Path "$svcDir\UrvarCrmApp.xml" -Encoding utf8

if (-not (Get-Service UrvarCrmApp -ErrorAction SilentlyContinue)) {
  & $svcExe install
} else {
  Write-Host "UrvarCrmApp service already installed."
}
Start-Service UrvarCrmApp -ErrorAction SilentlyContinue
Get-Service UrvarCrmApp | Select-Object Name, Status

Write-Host "`nAdmin-only setup complete." -ForegroundColor Green
Write-Host "Next (non-elevated terminal): npm run db:generate / db:migrate:deploy / npm run build, then Restart-Service UrvarCrmApp to pick up the new build." -ForegroundColor Green
