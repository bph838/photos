# Family Photos installer.
# - Copies the app to %LOCALAPPDATA%\Programs\FamilyPhotos (no admin rights needed)
# - Downloads its own private copy of Node.js (nothing is installed system-wide)
# - Downloads the AI models once, so everything then works offline
# - Adds a "Family Photos" icon to the Desktop and Start menu
# Running it again updates the app and keeps all names/tags.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Source  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest    = Join-Path $env:LOCALAPPDATA 'Programs\FamilyPhotos'
$Runtime = Join-Path $Dest 'runtime'
$Node    = Join-Path $Runtime 'node.exe'

function Say($msg) { Write-Host ''; Write-Host "  $msg" -ForegroundColor Cyan }

Write-Host ''
Write-Host '  ==============================' -ForegroundColor Yellow
Write-Host '    Family Photos - installing' -ForegroundColor Yellow
Write-Host '  ==============================' -ForegroundColor Yellow
Write-Host '  This needs the internet and takes about 5-10 minutes.'

try {
  # 1. Close the app if it is running (so its files can be updated)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Runtime, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

  # 2. Copy the app
  Say 'Copying the app...'
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  if ((Resolve-Path $Source).Path.TrimEnd('\') -ne (Resolve-Path $Dest).Path.TrimEnd('\')) {
    robocopy $Source $Dest /E /XD node_modules .git runtime /XF install.bat /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'Copying the app files failed.' }
  }

  # 3. A private copy of Node.js
  $needNode = $true
  if (Test-Path $Node) {
    $v = & $Node -v
    if ($v -match '^v(\d+)\.(\d+)') {
      $major = [int]$Matches[1]; $minor = [int]$Matches[2]
      if ($major -ge 23 -or ($major -eq 22 -and $minor -ge 13)) { $needNode = $false }
    }
  }
  if ($needNode) {
    Say 'Downloading Node.js (the engine the app runs on, about 30 MB)...'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $rel = $index | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
    if (-not $rel) { throw 'Could not find a Node.js download.' }
    $ver = $rel.version
    $zip = Join-Path $env:TEMP "familyphotos-node-$ver.zip"
    $tmp = Join-Path $env:TEMP "familyphotos-node-$ver"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip -UseBasicParsing
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $tar = Join-Path $env:WINDIR 'System32\tar.exe'
    if (Test-Path $tar) { & $tar -xf $zip -C $tmp } else { Expand-Archive $zip $tmp -Force }
    if (Test-Path $Runtime) { Remove-Item $Runtime -Recurse -Force }
    Move-Item (Join-Path $tmp "node-$ver-win-x64") $Runtime
    Remove-Item $zip -Force
    Remove-Item $tmp -Recurse -Force
  }
  $env:Path = "$Runtime;$env:Path"

  # 4. The app's building blocks
  Say 'Installing the app''s parts...'
  Push-Location $Dest
  & (Join-Path $Runtime 'npm.cmd') ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw 'Installing the app parts failed.' }

  # 5. AI models (face, pet and search)
  Say 'Downloading the face and pet finder (about 350 MB, once only)...'
  & $Node server\setup-models.js
  if ($LASTEXITCODE -ne 0) { throw 'Downloading the AI models failed.' }

  & $Node scripts\make-icon.js (Join-Path $Dest 'app.ico') | Out-Null
  Pop-Location

  # 6. A silent launcher (no black window) and shortcuts
  Say 'Adding the Family Photos icon...'
  $vbs = @'
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
extra = ""
If WScript.Arguments.Count > 0 Then extra = " " & WScript.Arguments(0)
sh.CurrentDirectory = dir
sh.Run """" & dir & "\runtime\node.exe"" """ & dir & "\server\index.js""" & extra, 0, False
'@
  Set-Content -Path (Join-Path $Dest 'Family Photos.vbs') -Value $vbs -Encoding ASCII

  function New-Shortcut($path, $arguments) {
    $ws = New-Object -ComObject WScript.Shell
    $s = $ws.CreateShortcut($path)
    $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $s.Arguments = "`"$Dest\Family Photos.vbs`" $arguments".Trim()
    $s.WorkingDirectory = $Dest
    $s.IconLocation = "$Dest\app.ico,0"
    $s.Description = 'Family Photos'
    $s.Save()
  }
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Family Photos.lnk') ''
  New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Family Photos.lnk') ''

  Write-Host ''
  $ans = Read-Host '  Start Family Photos quietly when the computer starts, so new photos are ready straight away? (recommended) [Y/n]'
  $startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Family Photos.lnk'
  if ($ans -match '^[nN]') {
    if (Test-Path $startup) { Remove-Item $startup -Force }
  } else {
    New-Shortcut $startup '--no-browser'
  }

  Write-Host ''
  Write-Host '  All done! Family Photos is opening now.' -ForegroundColor Green
  Write-Host '  Next time, use the "Family Photos" icon on the Desktop.' -ForegroundColor Green
  Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') "`"$Dest\Family Photos.vbs`""
}
catch {
  Write-Host ''
  Write-Host "  Sorry, the install did not finish: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Check the internet connection and try again.' -ForegroundColor Red
  exit 1
}
