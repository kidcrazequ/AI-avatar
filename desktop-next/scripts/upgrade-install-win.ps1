param([string]$Installer, [string]$Destination, [switch]$Uninstall, [switch]$WaitForExit)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Native Windows required' }
if ($WaitForExit) {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($watch.Elapsed.TotalSeconds -lt 120) {
    $active = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Installer })
    if ($active.Count -eq 0) {
      @{ ok = $true; installer = $Installer; waitSeconds = $watch.Elapsed.TotalSeconds } | ConvertTo-Json -Compress
      exit 0
    }
    Start-Sleep -Milliseconds 500
  }
  throw 'The owned NSIS update installer did not exit'
}
if ($Uninstall) { $arguments = '/S /currentuser' } else { $arguments = "/S /currentuser /D=$Destination" }
$process = Start-Process -FilePath $Installer -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
