# Revives the V7 paper-trading stack (dashboard + the agent it spawns) if either is gone.
# Owned by Task Scheduler so it does not die with a Qoder/terminal session.
# Writes to logs/watchdog.log only when it acts or fails, so it stays quiet while healthy.
$ErrorActionPreference = 'SilentlyContinue'
$Dir = 'C:\Trading System V7\paper-agent'
$Node = 'C:\Program Files\nodejs\node.exe'
$LogFile = Join-Path $Dir 'logs\watchdog.log'
$Port = 7070

function Note([string]$m) {
  ('{0}  {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m) | Add-Content -LiteralPath $LogFile
}
function PortUp([int]$p) {
  $null -ne (Get-NetTCPConnection -State Listen -LocalPort $p)
}

if (-not (PortUp $Port)) {
  if (-not (Test-Path $Node)) { Note "FAIL node.exe missing: $Node"; exit 1 }
  $cl = 'cmd.exe /c cd /d "' + $Dir + '" && "' + $Node + '" server.js >> server.out 2>&1'
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cl }
  Note "server create rc=$($r.ReturnValue) pid=$($r.ProcessId)"
  $deadline = (Get-Date).AddSeconds(25)
  while (-not (PortUp $Port) -and (Get-Date) -lt $deadline) { Start-Sleep 2 }
  if (-not (PortUp $Port)) { Note "FAIL port $Port still down"; exit 1 }
}

$s = Invoke-RestMethod -Uri "http://localhost:$Port/api/status" -TimeoutSec 10
if (-not $s) { Note 'FAIL /api/status unreachable'; exit 1 }
if (-not $s.agent.running) {
  $r = Invoke-RestMethod -Uri "http://localhost:$Port/api/agent/start" -Method Post -TimeoutSec 10
  $pid2 = (Invoke-RestMethod -Uri "http://localhost:$Port/api/status" -TimeoutSec 10).agent.pid
  Note "agent start ok=$($r.ok) pid=$pid2"
}
