param([Parameter(Mandatory)][string]$Installer)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'This destructive installer test only runs on an ephemeral GitHub-hosted Windows runner.'
}

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$t3Root = Join-Path $env:LOCALAPPDATA 'Programs\t3code'
$foundryRoot = Join-Path $env:LOCALAPPDATA 'Programs\foundry'
foreach ($path in @($t3Root, $foundryRoot, "$env:USERPROFILE\.t3", "$env:APPDATA\t3code-v2")) {
  if (Test-Path -LiteralPath $path) { throw "Test requires a clean runner: $path" }
}

function Invoke-Installer([string]$File, [string]$Arguments = '/S', [int]$ExpectedExit = 0) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    throw "Installer timed out: $File"
  }
  if ($process.ExitCode -ne $ExpectedExit) {
    throw "Installer exited $($process.ExitCode), expected ${ExpectedExit}: $File"
  }
}

function Get-T3Snapshot {
  Get-ChildItem -LiteralPath @($t3Root, "$env:USERPROFILE\.t3", "$env:APPDATA\t3code-v2") -File -Recurse |
    Sort-Object FullName | ForEach-Object {
    "$($_.FullName):$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
  }
}

function Assert-T3Unchanged {
  $after = @(Get-T3Snapshot)
  if (Compare-Object -ReferenceObject $before -DifferenceObject $after) {
    throw 'Foundry changed the original T3 installation or profile fixtures.'
  }
}

$official = Join-Path $env:RUNNER_TEMP 'T3-Code-0.1.6-x64.exe'
Invoke-WebRequest 'https://github.com/pingdotgg/t3code/releases/download/v0.1.6/T3-Code-0.1.6-x64.exe' -OutFile $official
if ((Get-FileHash $official -Algorithm SHA256).Hash -ne '8cff5c90fdc976c0bdef86074a8cde9c3784af8de2091759514cd9f8f1457405') {
  throw 'Official T3 installer checksum mismatch.'
}
Invoke-Installer $official
if (-not (Test-Path -LiteralPath "$t3Root\T3 Code (Beta).exe")) { throw 'Original T3 executable missing.' }

$sentinels = @("$env:USERPROFILE\.t3\userdata\isolation-sentinel", "$env:APPDATA\t3code-v2\isolation-sentinel")
foreach ($file in $sentinels) {
  New-Item -ItemType Directory -Path (Split-Path $file) -Force | Out-Null
  [IO.File]::WriteAllText($file, [guid]::NewGuid().ToString())
}
$before = @(Get-T3Snapshot)

Invoke-Installer $Installer
if (-not (Test-Path -LiteralPath "$foundryRoot\Foundry.exe")) { throw 'Foundry did not install into its own directory.' }
Assert-T3Unchanged
Write-Output 'PASS: real T3 and Foundry installations coexist; T3 files and profile fixtures unchanged.'

Invoke-Installer $Installer
Assert-T3Unchanged
Write-Output 'PASS: reinstall preserves T3.'

$probeProfile = Join-Path $env:APPDATA 'Foundry-Auth-Probe'
if (Test-Path -LiteralPath $probeProfile) { throw 'Probe profile must not exist before the launch test.' }
$watcher = [IO.FileSystemWatcher]::new($env:APPDATA, 'Foundry-Auth-Probe')
$subscription = Register-ObjectEvent $watcher Created -SourceIdentifier 'FoundryProbeProfile'
$watcher.EnableRaisingEvents = $true
$probe = $null
$probeErrorLog = Join-Path $env:RUNNER_TEMP 'foundry-probe-stderr.log'
try {
  $probe = Start-Process -FilePath "$foundryRoot\Foundry.exe" -ArgumentList @(
    '--foundry-access-probe', 'https://example.com', 'https://example.cloudflareaccess.com',
    'defd6cac-b437-407a-8a68-069161c9c1e4'
  ) -PassThru -RedirectStandardError $probeErrorLog
  $created = Wait-Event -SourceIdentifier 'FoundryProbeProfile' -Timeout 60
  if ($null -eq $created -or -not (Test-Path -LiteralPath $probeProfile)) {
    $details = Get-Content -LiteralPath $probeErrorLog -Raw -ErrorAction SilentlyContinue
    throw "The installed executable did not enter the isolated access probe. $details"
  }
  Write-Output 'PASS: installed executable enters the probe and creates its isolated profile (no login attempted).'
} finally {
  if ($null -ne $probe -and -not $probe.HasExited) {
    $probe.Kill($true)
    $probe.WaitForExit()
  }
  Unregister-Event -SourceIdentifier 'FoundryProbeProfile'
  Remove-Event -SourceIdentifier 'FoundryProbeProfile' -ErrorAction SilentlyContinue
  $watcher.Dispose()
}
Assert-T3Unchanged

$registration = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Foundry *' })
if ($registration.Count -ne 1) { throw 'Expected exactly one Foundry uninstall registration.' }
$installKey = "HKCU:\Software\$($registration[0].PSChildName)"
$originalLocation = (Get-ItemProperty -LiteralPath $installKey).InstallLocation
try {
  Set-ItemProperty -LiteralPath $installKey -Name InstallLocation -Value $t3Root
  Invoke-Installer $Installer '/S' 2
  Invoke-Installer $Installer "/S /D=$foundryRoot" 2
  Assert-T3Unchanged
} finally {
  Set-ItemProperty -LiteralPath $installKey -Name InstallLocation -Value $originalLocation
}
Invoke-Installer $Installer "/S /D=$t3Root" 2
Assert-T3Unchanged
Write-Output 'PASS: legacy colliding registration and explicit T3 target rejected before changes.'

Invoke-Installer "$foundryRoot\Uninstall Foundry.exe" "/S _?=$foundryRoot"
Assert-T3Unchanged
Write-Output 'PASS: uninstalling the corrected Foundry installation preserves T3.'
