param(
  [Parameter(Mandatory)][string]$Sample,
  [Parameter(Mandatory)][string]$ZipHash,
  [Parameter(Mandatory)][string]$InstallerHash,
  [Parameter(Mandatory)][string]$ReportDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Use an ephemeral GitHub-hosted Windows runner.'
}
if ($ZipHash -notmatch '^[a-fA-F0-9]{64}$' -or $InstallerHash -notmatch '^[a-fA-F0-9]{64}$') {
  throw 'Both expected SHA-256 values are required.'
}
New-Item -ItemType Directory -Path $ReportDirectory | Out-Null
$report = [ordered]@{ zipHash = $ZipHash; installerHash = $InstallerHash; scans = @(); completed = $false }
try {
  if ((Get-FileHash -LiteralPath $Sample -Algorithm SHA256).Hash -ne $ZipHash) { throw 'ZIP hash mismatch.' }
  Start-Service WinDefend
  # Hosted images disable archive/script scanning; restore them for this disposable scan.
  Set-MpPreference -DisableArchiveScanning $false -DisableScriptScanning $false -PUAProtection Enabled -ScanAvgCPULoadFactor 50
  Update-MpSignature
  $status = Get-MpComputerStatus
  $report.engine = $status.AMEngineVersion
  $report.product = $status.AMProductVersion
  $report.signatures = $status.AntivirusSignatureVersion
  $report.signatureUpdated = $status.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o')
  if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled -or $status.AntivirusSignatureAge -gt 1) {
    throw 'Defender is unavailable or signatures are stale.'
  }
  $report.archiveScanningDisabled = (Get-MpPreference).DisableArchiveScanning
  $report.cloudReporting = (Get-MpPreference).MAPSReporting
  $report.sampleSubmission = (Get-MpPreference).SubmitSamplesConsent
  if ($report.archiveScanningDisabled) { throw 'Archive scanning is disabled by runner policy.' }
  $command = Get-ChildItem "$env:ProgramData/Microsoft/Windows Defender/Platform/*/MpCmdRun.exe" |
    Sort-Object FullName -Descending | Select-Object -First 1
  if ($null -eq $command) { throw 'MpCmdRun is unavailable.' }

  function Invoke-SampleScan([string]$Path, [string]$Name) {
    # Forensic custom scans preserve the sample and ignore configured scan exclusions.
    & $command.FullName -Scan -ScanType 3 -File $Path -DisableRemediation 2>&1 |
      Tee-Object -FilePath (Join-Path $ReportDirectory "$Name.log")
    $exit = $LASTEXITCODE
    $report.scans += @{ file = $Name; exitCode = $exit }
    if ($exit -ne 0) { throw "Defender returned $exit for $Name; inspect the scan log and detections." }
  }

  Invoke-SampleScan $Sample 'archive'
  $archive = [IO.Compression.ZipFile]::OpenRead($Sample)
  $installer = Join-Path (Split-Path $Sample) 'installer.exe'
  try {
    if ($archive.Entries.Count -ne 1 -or $archive.Entries[0].Name -notlike '*.exe') {
      throw 'Expected one installer in the archive.'
    }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($archive.Entries[0], $installer, $false)
  } finally { $archive.Dispose() }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $InstallerHash) {
    throw 'Installer hash mismatch.'
  }
  $report.authenticode = (Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString()
  Invoke-SampleScan $installer 'installer'
  $report.completed = $true
} catch {
  $report.error = $_.Exception.Message
  throw
} finally {
  $report.detections = @(Get-MpThreatDetection -ErrorAction SilentlyContinue |
    Select-Object ThreatID, InitialDetectionTime, ActionSuccess, Resources)
  $report.threats = @(Get-MpThreat -ErrorAction SilentlyContinue |
    Select-Object ThreatID, ThreatName, IsActive, Resources)
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $ReportDirectory 'report.json')
}
