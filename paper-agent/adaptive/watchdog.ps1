$ErrorActionPreference = 'Stop'
$Dir = $PSScriptRoot
$Node = 'C:\Program Files\nodejs\node.exe'
$Runner = Join-Path $Dir 'v2\runner.js'
$Mutex = New-Object System.Threading.Mutex($false, 'Global\V7AdaptiveObserver')
$Acquired = $false
$Result = 0
try {
    try { $Acquired = $Mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $Acquired = $true }
    if (-not $Acquired) { exit 0 }
    $RunnerPattern = [regex]::Escape($Runner.Replace('\', '/'))
    $Processes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
    foreach ($Process in $Processes) {
        if (-not $Process.CommandLine) { throw 'Cannot verify node process command line; refusing a possible duplicate observer.' }
        $Command = $Process.CommandLine.Replace('\', '/')
        if ($Command -match $RunnerPattern -and $Command -match '(?:^|\s)--(?:watch|once)(?:\s|$)') { exit 0 }
    }
    if (-not (Test-Path -LiteralPath $Node)) { throw 'node.exe is unavailable.' }
    $Stdout = Join-Path $Dir 'observer.stdout.log'
    $Stderr = Join-Path $Dir 'observer.stderr.log'
    $Attempts = 3
    $TimeoutMs = 180000
    for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
        $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
        $StartInfo.FileName = $Node
        $StartInfo.Arguments = '"{0}" --once' -f $Runner
        $StartInfo.WorkingDirectory = $Dir
        $StartInfo.UseShellExecute = $false
        $StartInfo.CreateNoWindow = $true
        $StartInfo.RedirectStandardOutput = $true
        $StartInfo.RedirectStandardError = $true
        $Child = [System.Diagnostics.Process]::Start($StartInfo)
        $OutTask = $Child.StandardOutput.ReadToEndAsync()
        $ErrTask = $Child.StandardError.ReadToEndAsync()
        if (-not $Child.WaitForExit($TimeoutMs)) {
            try { $Child.Kill() } catch { }
            throw ('Observer timed out after {0}s; next scheduled run will retry.' -f ($TimeoutMs / 1000))
        }
        $Child.WaitForExit()
        $Detail = $ErrTask.Result
        [System.IO.File]::WriteAllText($Stdout, $OutTask.Result)
        [System.IO.File]::WriteAllText($Stderr, $Detail)
        $Result = $Child.ExitCode
        if ($Result -eq 0) { break }
        if ($Detail -notmatch 'certificate|CERT_|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|fetch failed|503|502|504') { break }
        if ($Attempt -lt $Attempts) { Start-Sleep -Seconds (10 * $Attempt) }
    }
    if ($Result -ne 0) { throw "Observer exited with code $Result after $Attempt attempt(s); next scheduled run will retry. See observer.stderr.log." }
} catch {
    $Result = 1
    ('{0} {1}' -f [DateTime]::UtcNow.ToString('o'), $_.Exception.Message) | Add-Content -LiteralPath (Join-Path $Dir 'watchdog.log')
} finally {
    if ($Acquired) { $Mutex.ReleaseMutex() }
    $Mutex.Dispose()
}
exit $Result
