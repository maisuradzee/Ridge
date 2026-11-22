[CmdletBinding()]
param(
    [int]$HostPort = 55432,
    [string]$PostgresImage = 'postgres:16-alpine'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$BackendRoot = Join-Path $ProjectRoot 'backend'
$MigrationRoot = Join-Path $ProjectRoot 'database\migrations'
if (!(Test-Path (Join-Path $BackendRoot 'package.json'))) { throw 'backend/package.json is missing.' }
if (!(Test-Path (Join-Path $MigrationRoot '001_initial_schema.sql'))) { throw 'Database migrations are missing.' }
if (!(Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker CLI is required for the isolated PostgreSQL test.' }

$ContainerName = 'ridge-pg-qa-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$Password = [Guid]::NewGuid().ToString('N')
$DatabaseUrl = "postgresql://ridge_qa:$Password@127.0.0.1:$HostPort/ridge_qa"
$EnvironmentNames = @('DATABASE_URL', 'RIDGE_DB_ENV', 'RIDGE_RUN_POSTGRES_INTEGRATION')
$PreviousEnvironment = @{}
foreach ($Name in $EnvironmentNames) {
    $PreviousEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
}

try {
    & docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Docker daemon is not running or is inaccessible.' }

    Write-Host "Starting disposable PostgreSQL container $ContainerName on 127.0.0.1:$HostPort..." -ForegroundColor Cyan
    & docker run -d --name $ContainerName `
        -e "POSTGRES_USER=ridge_qa" `
        -e "POSTGRES_PASSWORD=$Password" `
        -e "POSTGRES_DB=ridge_qa" `
        -p "127.0.0.1:${HostPort}:5432" `
        --tmpfs '/var/lib/postgresql/data:rw,noexec,nosuid,size=512m' `
        -v "${MigrationRoot}:/migrations:ro" `
        --health-cmd 'pg_isready -U ridge_qa -d ridge_qa' `
        --health-interval 2s --health-timeout 3s --health-retries 30 `
        $PostgresImage | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start disposable PostgreSQL container.' }

    $Ready = $false
    for ($Attempt = 1; $Attempt -le 60; $Attempt++) {
        & docker exec $ContainerName pg_isready -U ridge_qa -d ridge_qa *> $null
        if ($LASTEXITCODE -eq 0) { $Ready = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $Ready) { throw 'PostgreSQL did not become ready within 120 seconds.' }

    foreach ($Migration in (Get-ChildItem -LiteralPath $MigrationRoot -Filter '*.sql' | Sort-Object Name)) {
        Write-Host "Applying $($Migration.Name)..." -ForegroundColor Cyan
        & docker exec $ContainerName psql -v ON_ERROR_STOP=1 -U ridge_qa -d ridge_qa -f "/migrations/$($Migration.Name)"
        if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($Migration.Name)" }
    }

    Push-Location $BackendRoot
    try {
        if (!(Test-Path (Join-Path $BackendRoot 'node_modules\pg'))) {
            Write-Host 'Installing backend dependencies...' -ForegroundColor Cyan
            & npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
        }

        $env:DATABASE_URL = $DatabaseUrl
        $env:RIDGE_DB_ENV = 'development'
        $env:RIDGE_RUN_POSTGRES_INTEGRATION = 'YES'
        Write-Host 'Running PostgreSQL persistence/restart integration test...' -ForegroundColor Cyan
        & npm run test:postgres
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL integration test failed.' }
    }
    finally {
        Pop-Location
    }

    Write-Host 'PASS: migrations applied and PostgreSQL restart-persistence integration test completed.' -ForegroundColor Green
}
finally {
    foreach ($Name in $EnvironmentNames) {
        [Environment]::SetEnvironmentVariable($Name, $PreviousEnvironment[$Name], 'Process')
    }
    & docker rm -f $ContainerName *> $null
    # The database uses tmpfs and is intentionally discarded after this test.
}