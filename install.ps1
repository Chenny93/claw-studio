# Claw Studio 安装脚本：检查环境并创建桌面 / 开始菜单快捷方式
# 用法：右键 → 使用 PowerShell 运行；或  powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$App  = Join-Path $Here 'src\app'
Write-Host "`n=== Claw Studio 安装 ===`n" -ForegroundColor Cyan

# 1. 检查 Genspark Claw
$users = Join-Path $env:APPDATA 'Genspark Claw\users'
$state = Get-ChildItem $users -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'openclaw.json') } | Select-Object -First 1
if (-not $state) { Write-Host '✗ 没有找到 Genspark Claw 的用户数据。请先安装并登录 Genspark Claw：https://www.genspark.ai' -ForegroundColor Red; exit 1 }
Write-Host "✓ Genspark Claw 数据目录：$($state.FullName)"
$exe = $null; try { $exe = (Get-Content (Join-Path $state.FullName 'genclaw.json') -Raw | ConvertFrom-Json).cli.nodeBinary } catch {}
if ($exe -and (Test-Path $exe)) { Write-Host "✓ Genspark Claw 程序：$exe" } else { Write-Host '! 暂时没找到 Genspark Claw.exe（先打开一次 Genspark Claw 即可），启动时会自动搜索' -ForegroundColor Yellow }

# 2. 检查浏览器
$browser = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($browser) { Write-Host "✓ 窗口浏览器：$browser" } else { Write-Host '! 没有 Edge/Chrome，将用默认浏览器打开' -ForegroundColor Yellow }

# 3. ps1 需要 UTF-8 BOM（Windows PowerShell 5 读中文）
foreach ($f in Get-ChildItem $Here -Recurse -Filter *.ps1) { $t = [IO.File]::ReadAllText($f.FullName, [Text.Encoding]::UTF8); [IO.File]::WriteAllText($f.FullName, $t, (New-Object Text.UTF8Encoding $true)) }

# 4. 快捷方式（wscript //E:vbscript 避免 .vbs 文件关联被改的问题）
$ws = New-Object -ComObject WScript.Shell
$links = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claw Studio.lnk'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Claw Studio.lnk'))
foreach ($l in $links) {
  $s = $ws.CreateShortcut($l); $s.TargetPath = "$env:WINDIR\System32\wscript.exe"; $s.Arguments = "//E:vbscript //nologo `"$App\launch.vbs`""
  $s.WorkingDirectory = $App; $s.IconLocation = "$App\icon.ico,0"; $s.Description = 'Claw Studio - Genspark Claw 桌面工作台'; $s.Save()
  Write-Host "✓ 已创建快捷方式：$l"
}
Write-Host "`n完成！双击桌面上的「Claw Studio」即可启动。想固定到任务栏：右键图标 → 固定到任务栏。`n" -ForegroundColor Green
$r = Read-Host '现在启动吗？(Y/n)'; if ($r -ne 'n') { & "$env:WINDIR\System32\wscript.exe" //E:vbscript //nologo "$App\launch.vbs" }
