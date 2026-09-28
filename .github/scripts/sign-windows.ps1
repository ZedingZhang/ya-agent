$ErrorActionPreference = 'Stop'
$certificatePath = Join-Path $env:RUNNER_TEMP "ya-signing-$([guid]::NewGuid()).pfx"
$certificate = $null
try {
    [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($env:WIN_CSC_LINK))
    $password = ConvertTo-SecureString $env:WIN_CSC_KEY_PASSWORD -AsPlainText -Force
    $certificates = @(Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\My -Password $password)
    $certificate = $certificates | Where-Object HasPrivateKey | Select-Object -First 1
    if (-not $certificate) { throw 'Signing PFX has no private key.' }
    $cli = Join-Path 'release-cli' $env:CLI_ASSET
    $signature = Set-AuthenticodeSignature -FilePath $cli -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
    if ($signature.Status -ne 'Valid') { throw "CLI signing failed: $($signature.Status)" }
    $portable = @(Get-ChildItem release/electron/*.exe)
    if ($portable.Count -ne 1) { throw 'Expected exactly one portable desktop executable.' }
    $inner = @(Get-ChildItem release/electron/win-unpacked -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll', '.node' })
    if ($inner.Count -eq 0) { throw 'No unpacked desktop binaries found.' }
    foreach ($file in @((Get-Item $cli)) + $portable + $inner) {
        $signed = Get-AuthenticodeSignature -LiteralPath $file.FullName
        if ($signed.Status -ne 'Valid' -or -not $signed.TimeStamperCertificate) {
            throw "Missing valid timestamped signature: $($file.FullName) ($($signed.Status))"
        }
        if ($signed.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
            throw "Unexpected signing certificate: $($file.FullName)"
        }
    }
} finally {
    if ($certificate) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -DeleteKey }
    if (Test-Path -LiteralPath $certificatePath) { Remove-Item -LiteralPath $certificatePath }
}
