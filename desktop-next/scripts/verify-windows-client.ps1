param(
  [Parameter(Mandatory = $true)][ValidateSet('10', '11')][string]$ExpectedWindows,
  [string]$FixtureDirectory,
  [string]$EvidenceDirectory,
  [switch]$PreflightOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This acceptance requires native Windows' }
$root = Split-Path -Parent $PSScriptRoot
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path $root "evidence\windows-client-$ExpectedWindows" }
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
@{ ok = $false; state = 'not-completed' } | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'acceptance.json')
$os = Get-CimInstance Win32_OperatingSystem
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$administratorGroup = @($identity.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' }).Count -gt 0
$elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
$build = [int]$os.BuildNumber
$clientVersion = if ($build -ge 22000) { '11' } elseif ($build -ge 10240) { '10' } else { '' }
$sidHasher = [Security.Cryptography.SHA256]::Create()
try { $identityHash = [BitConverter]::ToString($sidHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity.User.Value))).Replace('-', '').ToLowerInvariant() } finally { $sidHasher.Dispose() }
$environment = [ordered]@{
  os = $os.Caption; version = $os.Version; build = $build; productType = [int]$os.ProductType
  expectedWindows = $ExpectedWindows; detectedWindows = $clientVersion
  architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  processArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
  elevated = $elevated; administratorGroupMember = $administratorGroup; sessionId = $session
  identitySha256 = $identityHash
}
$reasons = @()
if ($os.ProductType -ne 1 -or $clientVersion -ne $ExpectedWindows -or $os.Caption -notmatch "Windows $ExpectedWindows\b") { $reasons += 'expected-windows-client-required' }
if ($environment.architecture -ne 'X64' -or $environment.processArchitecture -ne 'X64') { $reasons += 'native-x64-required' }
if ($elevated -or $administratorGroup) { $reasons += 'standard-non-administrator-account-required' }
if ($session -eq 0) { $reasons += 'interactive-desktop-session-required' }
foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  if (Test-Path $registryRoot) {
    $existing = @(Get-ChildItem $registryRoot | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $displayName = $_.PSObject.Properties['DisplayName']; $displayName -and $displayName.Value -eq 'Soul Next' })
    if ($existing.Count) { $reasons += 'existing-soul-next-installation-must-be-preserved'; break }
  }
}
$preflight = @{ ok = ($reasons.Count -eq 0); capturedAt = [DateTime]::UtcNow.ToString('o'); environment = $environment; reasons = @($reasons) }
$preflight | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'environment.json')
if ($reasons.Count) { throw "Client acceptance refused: $($reasons -join ', ')" }
if ($PreflightOnly) { $preflight | ConvertTo-Json -Depth 8; exit 0 }
if (-not $FixtureDirectory) { throw 'Verified native fixture directory required' }
$fixture = Get-Content -Raw -Encoding UTF8 (Join-Path $FixtureDirectory 'windows-client-fixture.json') | ConvertFrom-Json
if ($fixture.schema -ne 1 -or $fixture.platform -ne 'win32' -or $fixture.arch -ne 'x64' -or $fixture.sourceSha -notmatch '^[a-f0-9]{40}$') { throw 'Invalid native fixture identity' }
if ($env:GITHUB_SHA -and $env:GITHUB_SHA -ne $fixture.sourceSha) { throw 'Fixture source differs from the requested workflow revision' }
$initial = Join-Path $FixtureDirectory $fixture.initial.file
$hasher = [Security.Cryptography.SHA256]::Create()
$stream = [IO.File]::OpenRead($initial)
try { $initialHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $stream.Dispose(); $hasher.Dispose() }
if ($initialHash -ne $fixture.initial.sha256) { throw 'Initial installer checksum mismatch' }
# The parent is a real standard account; installers and apps inherit that account.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'verify-install-win.ps1') -Installer $initial
if ($LASTEXITCODE -ne 0) { throw 'Client installation, launch or uninstall acceptance failed' }
$installed = Get-ChildItem (Join-Path $root 'evidence') -Directory -Filter 'windows-x64-*' | Sort-Object Name -Descending | Select-Object -First 1
$installation = Get-Content -Raw -Encoding UTF8 (Join-Path $installed.FullName 'installation.json') | ConvertFrom-Json
if (-not $installation.ok -or $installation.host.elevated -or $installation.host.administratorGroupMember -or $installation.host.sessionId -ne $session -or $installation.host.identitySha256 -ne $identityHash -or $installation.sourceSha -ne $fixture.sourceSha -or $installation.installerSha256 -ne $initialHash -or (($installation.launches -join ',') -ne '1,2')) { throw 'Client installation provenance or permissions mismatch' }
if ((Get-Content -Raw -Encoding UTF8 (Join-Path $installed.FullName 'uninstall.txt')) -notmatch 'Uninstall passed; persistent test data retained') { throw 'Client uninstall or retained-data evidence missing' }
& node (Join-Path $PSScriptRoot 'verify-upgrade.mjs') "--fixture-dir=$FixtureDirectory"
if ($LASTEXITCODE -ne 0) { throw 'Client actual updater upgrade acceptance failed' }
$upgraded = Get-ChildItem (Join-Path $root 'evidence') -Directory -Filter 'upgrade-win32-x64-*' | Sort-Object Name -Descending | Select-Object -First 1
$upgrade = Get-Content -Raw -Encoding UTF8 (Join-Path $upgraded.FullName 'upgrade.json') | ConvertFrom-Json
if (-not $upgrade.ok -or -not $upgrade.automaticInstall -or $upgrade.sourceSha -ne $fixture.sourceSha -or -not $upgrade.installerCompletion.filesMatchNativeBuild) { throw 'Client automatic upgrade evidence mismatch' }
foreach ($result in @($upgrade.after, $upgrade.restart)) {
  if (-not $result.ok -or $result.version -ne $fixture.to -or $result.preservedBusinessTables -ne 19 -or $result.preservedKnowledgeFiles -ne 26 -or $result.preservedPinnedSource -ne $upgrade.before.task.knowledge.original) { throw 'Client upgrade changed business data or the pinned source' }
}
$summary = @{
  ok = $true; environment = $environment; sourceSha = $fixture.sourceSha
  installationEvidence = $installed.FullName; upgradeEvidence = $upgraded.FullName
  launches = @(1, 2); uninstallPassed = $true; automaticUpgradePassed = $true
  preservedBusinessTables = 19; preservedKnowledgeFiles = 26
  scope = 'Actual native Windows client standard non-Administrators account in a desktop session; per-user silent NSIS install, installed application twice, uninstall with data retained, actual loopback updater download/backup/NSIS replacement and two upgraded launches. Signing and production update service are not configured.'
}
$summary | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $EvidenceDirectory 'acceptance.json')
$summary | ConvertTo-Json -Depth 8
