#requires -Version 5.1
<## Pure validation checks: extract the actual installer functions without executing installation,
changing ACLs, enrolling, registering a service, or requiring administrator rights. ##>
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$installerPath = Join-Path $PSScriptRoot 'Install-Agent.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($installerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors) { throw 'Installer has PowerShell syntax errors.' }
foreach ($functionName in @('Assert-LocalDirectory', 'Assert-OwnedDirectory', 'Write-OwnershipMarker')) {
    $functionAst = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false) | Where-Object { $_.Name -eq $functionName } | Select-Object -First 1
    if (-not $functionAst) { throw "Validation function missing: $functionName" }
    . ([scriptblock]::Create($functionAst.Extent.Text))
}
function Assert-Rejected([scriptblock]$Action, [string]$Description) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "Unsafe path accepted: $Description" }
    Write-Host "PASS $Description"
}
foreach ($unsafePath in @([IO.Path]::GetPathRoot($env:SystemRoot), $env:SystemRoot, $env:ProgramFiles, $env:ProgramData, [Environment]::GetFolderPath('UserProfile'), (Join-Path $env:SystemRoot 'LibraryRmm'), (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'LibraryRmm'), '\\server\LibraryRmm')) {
    Assert-Rejected { Assert-LocalDirectory $unsafePath } 'system/profile/shared target refused'
}
$installDefault = Join-Path $env:ProgramFiles 'LibraryRmm'
$dataDefault = Join-Path $env:ProgramData 'LibraryRmm'
if ((Assert-LocalDirectory $installDefault) -ne $installDefault -or (Assert-LocalDirectory $dataDefault) -ne $dataDefault) { throw 'Dedicated default paths rejected.' }
Write-Host 'PASS dedicated default paths accepted without mutation'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('library-rmm-installer-path-tests-' + [guid]::NewGuid().ToString('N'))
$testDirectory = Join-Path $testRoot 'LibraryRmm'
New-Item -Path $testDirectory -ItemType Directory -Force | Out-Null
try {
    Assert-OwnedDirectory $testDirectory 'install'
    [IO.File]::WriteAllText((Join-Path $testDirectory 'unrelated.txt'), 'original unrelated file')
    Assert-Rejected { Assert-OwnedDirectory $testDirectory 'install' } 'nonempty unowned directory refused before ACL changes'
    if ([IO.File]::ReadAllText((Join-Path $testDirectory 'unrelated.txt')) -ne 'original unrelated file') { throw 'Validation changed an existing file.' }
    Write-OwnershipMarker $testDirectory 'data'
    Assert-Rejected { Assert-OwnedDirectory $testDirectory 'install' } 'wrong-role ownership marker refused'
    Write-OwnershipMarker $testDirectory 'install'
    Assert-OwnedDirectory $testDirectory 'install'
    Write-Host 'PASS correctly marked existing directory accepted'
    [IO.File]::WriteAllText((Join-Path $testDirectory '.library-rmm-owned.json'), 'invalid marker')
    Assert-Rejected { Assert-OwnedDirectory $testDirectory 'install' } 'invalid ownership marker refused'
} finally {
    $absoluteTestRoot = [IO.Path]::GetFullPath($testRoot)
    $absoluteTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $absoluteTestRoot.StartsWith($absoluteTemp, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($absoluteTestRoot) -notlike 'library-rmm-installer-path-tests-*') { throw 'Refusing test cleanup outside temporary workspace.' }
    Remove-Item -LiteralPath $absoluteTestRoot -Recurse -Force
}
Write-Host 'Installer validation checks passed; no ACL, service, enrollment, or reboot action occurred.'
