[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$UnrealRoot = $env:RIDGE_UE_ROOT,
    [Parameter(Mandatory = $false)]
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($UnrealRoot)) {
    throw 'Set RIDGE_UE_ROOT or pass -UnrealRoot to inspect the UE 5.8 crypto provider.'
}

$UnrealRoot = (Resolve-Path -LiteralPath $UnrealRoot).Path
$VersionFile = Join-Path $UnrealRoot 'Engine\Build\Build.version'
if (!(Test-Path -LiteralPath $VersionFile -PathType Leaf)) {
    throw "Unreal Build.version was not found: $VersionFile"
}
$Version = Get-Content -LiteralPath $VersionFile -Raw | ConvertFrom-Json
if ([int]$Version.MajorVersion -ne 5 -or [int]$Version.MinorVersion -ne 8) {
    throw "Expected Unreal Engine 5.8, found $($Version.MajorVersion).$($Version.MinorVersion)."
}

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $ReportPath = Join-Path $ProjectRoot 'RIDGE_GIS\Data\QA\ridge_ue58_crypto_provider_probe.json'
}
$ReportPath = [System.IO.Path]::GetFullPath($ReportPath)
New-Item -ItemType Directory -Path (Split-Path -Parent $ReportPath) -Force | Out-Null

$PlatformCryptoPlugin = Join-Path $UnrealRoot 'Engine\Plugins\Experimental\PlatformCrypto\PlatformCrypto.uplugin'
$AesGcmPlugin = Join-Path $UnrealRoot 'Engine\Plugins\Runtime\PacketHandlers\AESGCMHandlerComponent\AESGCMHandlerComponent.uplugin'
$ContextHeader = Join-Path $UnrealRoot 'Engine\Plugins\Experimental\PlatformCrypto\Source\PlatformCryptoContext\Public\EncryptionContextOpenSSL.h'
$ThirdPartyRoot = Join-Path $UnrealRoot 'Engine\Source\ThirdParty\OpenSSL'
$OpenSSLBuildRule = Join-Path $ThirdPartyRoot 'OpenSSL.Build.cs'

$ContextText = ''
if (Test-Path -LiteralPath $ContextHeader -PathType Leaf) {
    $ContextText = Get-Content -LiteralPath $ContextHeader -Raw
}

$HeaderFiles = @()
if (Test-Path -LiteralPath $ThirdPartyRoot -PathType Container) {
    $HeaderFiles = @(Get-ChildItem -LiteralPath $ThirdPartyRoot -Filter 'opensslv.h' -File -Recurse -ErrorAction SilentlyContinue)
}

$OpenSSLCandidates = @(
    foreach ($Header in $HeaderFiles) {
        $OpenSSLInclude = Split-Path -Parent $Header.FullName
        $IncludeRoot = Split-Path -Parent $OpenSSLInclude
        $EvpHeader = Join-Path $OpenSSLInclude 'evp.h'
        $KdfHeader = Join-Path $OpenSSLInclude 'kdf.h'
        $VersionText = Get-Content -LiteralPath $Header.FullName -Raw
        $EvpText = if (Test-Path -LiteralPath $EvpHeader -PathType Leaf) { Get-Content -LiteralPath $EvpHeader -Raw } else { '' }
        $KdfText = if (Test-Path -LiteralPath $KdfHeader -PathType Leaf) { Get-Content -LiteralPath $KdfHeader -Raw } else { '' }
        $CombinedApiText = $EvpText + [Environment]::NewLine + $KdfText
        $VersionMatch = [regex]::Match($VersionText, 'OPENSSL_VERSION_TEXT\s+"([^"]+)"')
        [pscustomobject]@{
            VersionHeader = $Header.FullName
            IncludeRoot = $IncludeRoot
            VersionText = if ($VersionMatch.Success) { $VersionMatch.Groups[1].Value } else { $null }
            HasEvpHeader = Test-Path -LiteralPath $EvpHeader -PathType Leaf
            HasKdfHeader = Test-Path -LiteralPath $KdfHeader -PathType Leaf
            HasX25519EvpApi = $EvpText -match '\bEVP_PKEY_X25519\b'
            HasHkdfEvpApi = ($CombinedApiText -match '\bEVP_PKEY_HKDF\b') -or
                ($CombinedApiText -match 'EVP_PKEY_CTX_set_hkdf_md')
        }
    }
)

$OpenSSLLibraries = @()
if (Test-Path -LiteralPath $ThirdPartyRoot -PathType Container) {
    $OpenSSLLibraries = @(
        Get-ChildItem -LiteralPath $ThirdPartyRoot -File -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(libcrypto|libssl|crypto|ssl).*\.(lib|a|so|dll)$' } |
        Select-Object -First 40 -ExpandProperty FullName
    )
}

$BuildRuleText = ''
if (Test-Path -LiteralPath $OpenSSLBuildRule -PathType Leaf) {
    $BuildRuleText = Get-Content -LiteralPath $OpenSSLBuildRule -Raw
}

$PlatformCryptoApi = [ordered]@{
    ContextHeaderFound = Test-Path -LiteralPath $ContextHeader -PathType Leaf
    ExposesAes256Gcm = $ContextText -match 'CreateEncryptor_AES_256_GCM|Encrypt_AES_256_GCM'
    ExposesRandomBytes = $ContextText -match 'CreateRandomBytes'
    ExposesSha256 = $ContextText -match 'CalcSHA256|CreateSHA256Hasher'
    ExposesRsa = $ContextText -match 'GenerateKey_RSA|CreateKey_RSA'
    ExposesX25519 = $ContextText -match 'X25519|EVP_PKEY_X25519'
    ExposesHkdf = $ContextText -match 'HKDF|EVP_PKEY_HKDF'
}

$ProviderStatus = 'ENGINE_HEADER_INSPECTION_REQUIRED'
if (@($OpenSSLCandidates | Where-Object { $_.HasX25519EvpApi -and $_.HasHkdfEvpApi }).Count -gt 0) {
    $ProviderStatus = 'OPENSSL_HEADERS_EXPOSE_X25519_AND_HKDF_COMPILE_REQUIRED'
}
elseif ($OpenSSLCandidates.Count -gt 0) {
    $ProviderStatus = 'OPENSSL_HEADERS_FOUND_BUT_REQUIRED_APIS_NOT_CONFIRMED'
}
elseif (!(Test-Path -LiteralPath $ThirdPartyRoot -PathType Container)) {
    $ProviderStatus = 'UE_THIRDPARTY_OPENSSL_DIRECTORY_NOT_FOUND'
}

$Report = [ordered]@{
    Schema = 'ridge.ue58.crypto-provider-probe.v1'
    GeneratedAtUtc = [DateTime]::UtcNow.ToString('o')
    EngineVersion = "$($Version.MajorVersion).$($Version.MinorVersion).$($Version.PatchVersion)"
    PlatformCryptoPluginFound = Test-Path -LiteralPath $PlatformCryptoPlugin -PathType Leaf
    AesGcmHandlerPluginFound = Test-Path -LiteralPath $AesGcmPlugin -PathType Leaf
    PlatformCryptoApi = $PlatformCryptoApi
    OpenSSLThirdParty = [ordered]@{
        SearchRoot = $ThirdPartyRoot
        BuildRuleFound = Test-Path -LiteralPath $OpenSSLBuildRule -PathType Leaf
        BuildRuleDeclaresPrivateStaticDependency = $BuildRuleText -match 'AddEngineThirdPartyPrivateStaticDependencies'
        HeaderCandidateCount = $OpenSSLCandidates.Count
        Candidates = $OpenSSLCandidates
        LibraryArtifacts = $OpenSSLLibraries
    }
    ProviderAssessment = $ProviderStatus
    Limitations = @(
        'This report inspects files and public header declarations only; it does not compile or link a crypto probe.',
        'Header availability does not prove the matching library exports the API or that the target platform enables the algorithm.',
        'No ECDH/HKDF provider is selected automatically and no production transport gate is changed.'
    )
}

$Report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
Write-Host "RIDGE UE 5.8 crypto provider inspection: $ProviderStatus" -ForegroundColor Cyan
Write-Host "Crypto provider report: $ReportPath" -ForegroundColor Cyan
