param([string]$Installer, [string]$Destination, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Native Windows required' }
if ($Uninstall) { $arguments = '/S /currentuser' } else { $arguments = "/S /currentuser /D=$Destination" }
$process = Start-Process -FilePath $Installer -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
