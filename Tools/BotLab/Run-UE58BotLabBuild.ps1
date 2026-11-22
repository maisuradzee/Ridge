[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$UnrealRoot = $env:RIDGE_UE_ROOT,

    [Parameter(Mandatory = $false)]
    [switch]$BuildDedicatedServer
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($UnrealRoot)) {
    throw 'Set RIDGE_UE_ROOT to the Unreal Engine 5.8 installation directory or pass -UnrealRoot.'
}

$UnrealRoot = (Resolve-Path -LiteralPath $UnrealRoot).Path
$BuildScript = Join-Path $UnrealRoot 'Engine\Build\BatchFiles\Build.bat'
$ProjectFile = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\RIDGE.uproject')).Path

if (-not (Test-Path -LiteralPath $BuildScript -PathType Leaf)) {
    throw "Unreal Build.bat was not found: $BuildScript"
}

$VersionFile = Join-Path $UnrealRoot 'Engine\Build\Build.version'
if (-not (Test-Path -LiteralPath $VersionFile -PathType Leaf)) {
    throw "Unreal Build.version was not found: $VersionFile"
}

$Version = Get-Content -LiteralPath $VersionFile -Raw | ConvertFrom-Json
if ([int]$Version.MajorVersion -ne 5 -or [int]$Version.MinorVersion -ne 8) {
    throw "RIDGE V14 targets Unreal Engine 5.8; found $($Version.MajorVersion).$($Version.MinorVersion)."
}

Write-Host 'Building RIDGEEditor Win64 Development...' -ForegroundColor Cyan
& $BuildScript 'RIDGEEditor' 'Win64' 'Development' "-Project=$ProjectFile" '-WaitMutex' '-NoHotReloadFromIDE'
if ($LASTEXITCODE -ne 0) {
    throw "RIDGEEditor build failed with exit code $LASTEXITCODE. See Unreal build output above."
}

if ($BuildDedicatedServer) {
    Write-Host 'Building RIDGEServer Win64 Development...' -ForegroundColor Cyan
    & $BuildScript 'RIDGEServer' 'Win64' 'Development' "-Project=$ProjectFile" '-WaitMutex' '-NoHotReloadFromIDE'
    if ($LASTEXITCODE -ne 0) {
        throw "RIDGEServer build failed with exit code $LASTEXITCODE. See Unreal build output above."
    }
}

Write-Host 'Requested RIDGE Unreal build targets completed successfully.' -ForegroundColor Green
Write-Host 'This script compiles targets only; run the UE BotLab map and telemetry validation separately.'
