[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$UnrealRoot = $env:RIDGE_UE_ROOT,
    [Parameter(Mandatory = $false)]
    [ValidateSet('Win64')]
    [string]$Platform = 'Win64',
    [Parameter(Mandatory = $false)]
    [ValidateSet('Development', 'Shipping')]
    [string]$Configuration = 'Development',
    [Parameter(Mandatory = $false)]
    [switch]$BuildDedicatedServer,
    [Parameter(Mandatory = $false)]
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($UnrealRoot)) {
    throw 'Set RIDGE_UE_ROOT to the Unreal Engine 5.8 installation directory or pass -UnrealRoot.'
}

$UnrealRoot = (Resolve-Path -LiteralPath $UnrealRoot).Path
$BuildScript = Join-Path $UnrealRoot 'Engine\Build\BatchFiles\Build.bat'
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$ProjectFile = Join-Path $ProjectRoot 'RIDGE.uproject'

if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) { throw "Unreal Build.bat was not found: $BuildScript" }
if (-not (Test-Path -LiteralPath $ProjectFile -PathType Leaf)) { throw "RIDGE.uproject was not found: $ProjectFile" }

$VersionFile = Join-Path $UnrealRoot 'Engine\Build\Build.version'
if (-not (Test-Path -LiteralPath $VersionFile -PathType Leaf)) { throw "Unreal Build.version was not found: $VersionFile" }
$Version = Get-Content -LiteralPath $VersionFile -Raw | ConvertFrom-Json
if ([int]$Version.MajorVersion -ne 5 -or [int]$Version.MinorVersion -ne 8) {
    throw "RIDGE targets Unreal Engine 5.8; found $($Version.MajorVersion).$($Version.MinorVersion)."
}

if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path $ProjectRoot 'RIDGE_GIS\Data\QA\ridge_ue58_build_report.json'
}
$ReportPath = [System.IO.Path]::GetFullPath($ReportPath)
$ReportDirectory = Split-Path -Parent $ReportPath
New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
$LogDirectory = Join-Path $ReportDirectory 'ue58_build_logs'
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

$Targets = @(
    [pscustomobject]@{ Name = 'RIDGE'; Purpose = 'Main game executable / client runtime' },
    [pscustomobject]@{ Name = 'RIDGEEditor'; Purpose = 'Editor and PIE runtime' }
)
if ($BuildDedicatedServer) {
    $Targets += [pscustomobject]@{ Name = 'RIDGEServer'; Purpose = 'Dedicated Server runtime' }
}

$Results = @()
foreach ($Target in $Targets) {
    Write-Host "Building $($Target.Name) $Platform $Configuration..." -ForegroundColor Cyan
    $Arguments = @($Target.Name, $Platform, $Configuration, "-Project=$ProjectFile", '-WaitMutex', '-NoHotReloadFromIDE')
    $Output = @()
    $ExitCode = 1
    try {
        $Output = & $BuildScript @Arguments 2>&1
        $ExitCode = $LASTEXITCODE
    }
    catch {
        $Output += $_.ToString()
        $ExitCode = 1
    }

    $LogPath = Join-Path $LogDirectory ($Target.Name + '_' + $Platform + '_' + $Configuration + '.log')
    $Output | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $LogPath -Encoding UTF8
    $Status = if ($ExitCode -eq 0) { 'PASS' } else { 'FAIL' }
    $Results += [pscustomobject]@{
        Target = $Target.Name
        Purpose = $Target.Purpose
        Platform = $Platform
        Configuration = $Configuration
        ExitCode = $ExitCode
        Status = $Status
        Log = $LogPath
    }

    if ($ExitCode -eq 0) { Write-Host "$($Target.Name): PASS" -ForegroundColor Green }
    else { Write-Host "$($Target.Name): FAIL (exit $ExitCode)" -ForegroundColor Red }
}

$FailedCount = @($Results | Where-Object { $_.Status -ne 'PASS' }).Count
$OverallStatus = if ($FailedCount -eq 0) { 'PASS' } else { 'FAIL' }
$Report = [ordered]@{
    Schema = 'ridge.ue58.build-report.v1'
    GeneratedAtUtc = [DateTime]::UtcNow.ToString('o')
    EngineVersion = "$($Version.MajorVersion).$($Version.MinorVersion).$($Version.PatchVersion)"
    Platform = $Platform
    Configuration = $Configuration
    Project = 'RIDGE.uproject'
    OverallStatus = $OverallStatus
    UBTAndUHT = if ($OverallStatus -eq 'PASS') { 'PASS' } else { 'FAIL' }
    Targets = $Results
}
$Report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "Build report: $ReportPath" -ForegroundColor Cyan
Write-Host "Build logs: $LogDirectory" -ForegroundColor Cyan
if ($FailedCount -gt 0) { throw "$FailedCount RIDGE Unreal build target(s) failed. Inspect the build report and per-target logs." }

Write-Host 'All requested RIDGE Unreal Engine 5.8 build targets completed successfully.' -ForegroundColor Green
Write-Host 'Next run the PIE and Dedicated Server tests in UE58_INTEGRATION_CHECKLIST_GE.md.'
