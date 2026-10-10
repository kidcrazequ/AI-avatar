param([string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Windows installation must be verified on native Windows' }
if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'This gate requires a native Windows x64 host' }
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -Encoding UTF8 (Join-Path $root 'package.json') | ConvertFrom-Json).version
if (-not $Installer) {
  $Installer = Join-Path $root "release\Soul-Next-$version-win-x64.exe"
}
if (-not $Installer -or -not (Test-Path $Installer)) { throw 'NSIS installer not found' }
$stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$evidence = Join-Path $root "evidence\windows-x64-$stamp"
# Keep dictionaries on an ASCII path while explicitly exercising Unicode userData.
$installDir = Join-Path $env:LOCALAPPDATA "Soul Next Verification $stamp"
$verificationProfile = Join-Path $env:LOCALAPPDATA "Soul Next Verification Data $stamp\测试用户 数据"
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$installerLog = Join-Path $evidence 'installer.txt'
$process = Start-Process -FilePath $Installer -ArgumentList "/S /currentuser /D=$installDir" -Wait -PassThru
"Installer=$Installer`nExitCode=$($process.ExitCode)`nInstallDir=$installDir" | Set-Content -Encoding UTF8 $installerLog
if ($process.ExitCode -ne 0) { throw "NSIS install failed: $($process.ExitCode)" }
$executable = Join-Path $installDir 'Soul Next.exe'
if (-not (Test-Path $executable)) { throw "Installed executable missing: $executable" }
$runs = @()
foreach ($iteration in 1, 2) {
  $output = Join-Path $evidence "launch-$iteration.json"
  $stdout = Join-Path $evidence "launch-$iteration.stdout.log"
  $stderr = Join-Path $evidence "launch-$iteration.stderr.log"
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $executable
  $startInfo.Arguments = "`"--verify-output=$output`" `"--profile=$verificationProfile`""
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(90000)) { $process.Kill(); throw 'Installed app timed out' }
  $process.WaitForExit()
  [IO.File]::WriteAllText($stdout, $stdoutTask.Result)
  [IO.File]::WriteAllText($stderr, $stderrTask.Result)
  $exitCode = $process.ExitCode
  $process.Dispose()
  if ($exitCode -ne 0) {
    if (Test-Path $output) { Get-Content -Raw -Encoding UTF8 $output | Write-Output }
    throw "Installed app failed: $exitCode, see $output"
  }
  $report = Get-Content -Raw -Encoding UTF8 $output | ConvertFrom-Json
  if (-not $report.ok -or -not $report.packaged -or $report.execPath -ne $executable -or $report.status.persistenceRun -ne $iteration -or $report.status.platform -ne 'win32' -or $report.status.arch -ne 'x64' -or $report.status.version -ne $version -or $report.workflowRenderChecks.Count -lt 12 -or ($iteration -eq 2 -and -not ($report.workflowRenderChecks | Where-Object { $_.PSObject.Properties.Name -contains 'installedWorkflowResume' })) -or $report.taskRenderChecks.Count -lt 10 -or ($iteration -eq 2 -and -not ($report.taskRenderChecks | Where-Object { $_.PSObject.Properties.Name -contains 'installedResume' }))) { throw "Install verification mismatch: $output" }
  if ($iteration -eq 1) { Start-Sleep -Milliseconds 1500 }
  $runs += $report
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$installerHasher = [Security.Cryptography.SHA256]::Create()
$installerStream = [IO.File]::OpenRead($Installer)
try {
  $installerSha256 = [BitConverter]::ToString($installerHasher.ComputeHash($installerStream)).Replace('-', '').ToLowerInvariant()
} finally {
  $installerStream.Dispose()
  $installerHasher.Dispose()
}
$summary = @{
  ok = $true
  installer = $Installer
  installerSha256 = $installerSha256
  executable = $executable
  profile = $verificationProfile
  sourceSha = $runs[0].status.sourceSha
  resourceSha256 = $runs[0].status.resources.sha256
  launches = @($runs | ForEach-Object { $_.status.persistenceRun })
  host = @{ os = [Microsoft.Win32.Registry]::GetValue('HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion', 'ProductName', 'Windows'); version = $runs[0].host.release; architecture = 'x64'; elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  scope = 'Native Windows build; actual per-user silent NSIS install; installed EXE launched twice with Unicode userData. Unsigned internal verification; interactive wizard, Windows 10/11 end-user trust and auto-update remain separate gates.'
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $evidence 'installation.json')
$summary | ConvertTo-Json -Depth 8
# Verify uninstall after saving evidence. It must remove the installed program without deleting user data.
$uninstaller = Join-Path $installDir 'Uninstall Soul Next.exe'
if (-not (Test-Path $uninstaller)) { throw 'Installed uninstaller missing' }
$process = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Uninstall failed: $($process.ExitCode)" }
for ($attempt = 0; $attempt -lt 30 -and (Test-Path $executable); $attempt++) { Start-Sleep -Milliseconds 1000 }
if (Test-Path $executable) { throw 'Uninstaller did not remove the installed executable' }
if (-not (Test-Path (Join-Path $verificationProfile 'validation.sqlite'))) { throw 'Uninstall deleted persistent test data' }
'Uninstall passed; persistent test data retained' | Set-Content -Encoding UTF8 (Join-Path $evidence 'uninstall.txt')
