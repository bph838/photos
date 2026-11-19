# Removes Family Photos. Your photos are NEVER touched by this.
$ErrorActionPreference = 'Continue'
$Dest = Join-Path $env:LOCALAPPDATA 'Programs\FamilyPhotos'
$Data = Join-Path $env:LOCALAPPDATA 'FamilyPhotos'

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Dest, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Startup'))) {
  $lnk = Join-Path $dir 'Family Photos.lnk'
  if (Test-Path $lnk) { Remove-Item $lnk -Force }
}

Write-Host ''
Write-Host '  Family Photos has been removed. Your photos have not been touched.'
$ans = Read-Host '  Also delete the names and tags you added (cannot be undone)? [y/N]'
if ($ans -match '^[yY]' -and (Test-Path $Data)) { Remove-Item $Data -Recurse -Force }
if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
