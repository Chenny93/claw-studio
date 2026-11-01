# Claw Studio 启动器
# 1) Genspark Claw 没开 → 后台启动并等待网关就绪（冷启动可能需要 1–3 分钟）
# 2) Claw Studio 服务没开 → 用 Claw 自带的 Electron 以 Node 模式运行 server.js（无需单独安装 Node.js）
# 3) 用 Edge / Chrome 的 --app 模式打开独立窗口
$ErrorActionPreference = 'SilentlyContinue'
$Root   = Split-Path -Parent $PSScriptRoot          # ...\src
$UiPort = if ($env:CLAW_STUDIO_PORT) { [int]$env:CLAW_STUDIO_PORT } else { 28900 }
$Url    = "http://127.0.0.1:$UiPort/"
$DataDir = Join-Path $env:LOCALAPPDATA 'ClawStudio'
$ProfileDir = Join-Path $DataDir 'browser'
$Log = Join-Path $DataDir 'launch.log'
New-Item -ItemType Directory -Force $DataDir | Out-Null
function L($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Encoding UTF8 $Log }
function PortUp($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

# ---- 定位 Genspark Claw ----
$ClawRoot = Join-Path $env:APPDATA 'Genspark Claw'
$StateDir = $env:CLAW_STATE_DIR
if (-not $StateDir) {
  $StateDir = Get-ChildItem (Join-Path $ClawRoot 'users') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'openclaw.json') } |
    Sort-Object { (Get-Item (Join-Path $_.FullName 'openclaw.json')).LastWriteTime } -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$GwPort = 28815; $ClawExe = $env:CLAW_EXE
try { $g = Get-Content (Join-Path $StateDir 'genclaw.json') -Raw | ConvertFrom-Json; if ($g.port) { $GwPort = $g.port }; if (-not $ClawExe -and $g.cli.nodeBinary) { $ClawExe = $g.cli.nodeBinary } } catch {}
if (-not $ClawExe -or -not (Test-Path $ClawExe)) {
  $c = Get-ChildItem "$env:LOCALAPPDATA\Programs", "$env:ProgramFiles", "${env:ProgramFiles(x86)}", 'C:\', 'D:\' -Filter 'Genspark Claw.exe' -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $ClawExe = $c.FullName }
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$splash = $null
function Show-Splash($text) {
  if (-not $script:splash) {
    $f = New-Object Windows.Forms.Form
    $f.FormBorderStyle = 'None'; $f.StartPosition = 'CenterScreen'; $f.Size = New-Object Drawing.Size(380, 128)
    $f.BackColor = [Drawing.Color]::FromArgb(23, 23, 28); $f.TopMost = $true; $f.ShowInTaskbar = $false
    $pb = New-Object Windows.Forms.PictureBox; $pb.Size = New-Object Drawing.Size(56, 56); $pb.Location = New-Object Drawing.Point(22, 34)
    $pb.SizeMode = 'Zoom'; $png = Join-Path $PSScriptRoot 'icon_192.png'; if (Test-Path $png) { $pb.Image = [Drawing.Image]::FromFile($png) }
    $t1 = New-Object Windows.Forms.Label; $t1.Text = 'Claw Studio'; $t1.ForeColor = 'White'; $t1.Font = New-Object Drawing.Font('Segoe UI Semibold', 13)
    $t1.Location = New-Object Drawing.Point(92, 28); $t1.AutoSize = $true
    $t2 = New-Object Windows.Forms.Label; $t2.ForeColor = [Drawing.Color]::FromArgb(160, 160, 175); $t2.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9.5)
    $t2.Location = New-Object Drawing.Point(94, 60); $t2.Size = New-Object Drawing.Size(270, 50)
    $f.Controls.AddRange(@($pb, $t1, $t2)); $f.Tag = $t2; $f.Show(); $script:splash = $f
  }
  $script:splash.Tag.Text = $text; [Windows.Forms.Application]::DoEvents()
}
function Close-Splash { if ($script:splash) { $script:splash.Close(); $script:splash = $null } }
function Fail($msg) { Close-Splash; [Windows.Forms.MessageBox]::Show($msg, 'Claw Studio', 'OK', 'Warning') | Out-Null; L "FAIL $msg"; exit 1 }

L "launch start state=$StateDir claw=$ClawExe gw=$GwPort"
if (-not $StateDir) { Fail "没有找到 Genspark Claw 的用户数据。`n请先安装并登录 Genspark Claw：https://www.genspark.ai" }
if (-not $ClawExe) { Fail "没有找到 Genspark Claw.exe。`n可以设置环境变量 CLAW_EXE 指向它。" }

# ---------- 1. Genspark Claw ----------
if (-not (PortUp $GwPort)) {
  Show-Splash '正在后台启动 Genspark Claw…'
  if (-not (Get-Process 'Genspark Claw' -ErrorAction SilentlyContinue)) { Start-Process -FilePath $ClawExe -WindowStyle Minimized; L 'started claw' }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while (-not (PortUp $GwPort) -and $sw.Elapsed.TotalSeconds -lt 300) {
    Start-Sleep -Milliseconds 400
    Show-Splash ("正在后台启动 Genspark Claw… {0} 秒`n（冷启动通常 1–3 分钟，请稍候）" -f [int]$sw.Elapsed.TotalSeconds)
  }
  Start-Sleep -Milliseconds 800
  Add-Type 'using System;using System.Runtime.InteropServices;public class CSW{[DllImport("user32.dll")]public static extern bool ShowWindowAsync(IntPtr h,int c);}'
  Get-Process 'Genspark Claw' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [CSW]::ShowWindowAsync($_.MainWindowHandle, 6) | Out-Null }
  if (-not (PortUp $GwPort)) { Fail "Genspark Claw 5 分钟内没有启动完成。`n请手动打开 Genspark Claw 后再试。" }
  L "gateway up after $([int]$sw.Elapsed.TotalSeconds)s"
}

# ---------- 2. Claw Studio 服务 ----------
if (-not (PortUp $UiPort)) {
  Show-Splash '正在启动 Claw Studio 服务…'
  $env:ELECTRON_RUN_AS_NODE = '1'
  Start-Process -FilePath $ClawExe -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardError (Join-Path $DataDir 'server.err.log') -RedirectStandardOutput (Join-Path $DataDir 'server.out.log')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while (-not (PortUp $UiPort) -and $sw.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 250 }
  if (-not (PortUp $UiPort)) { Fail ("Claw Studio 服务启动失败。`n日志：" + (Join-Path $DataDir 'server.err.log')) }
  L 'ui up'
}

# ---------- 3. 窗口 ----------
Show-Splash '正在打开窗口…'
$browser = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($browser) {
  Start-Process -FilePath $browser -ArgumentList "--app=$Url", "--user-data-dir=`"$ProfileDir`"", '--window-size=1400,900', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate', '--disable-sync'
} else { Start-Process $Url }
Start-Sleep -Milliseconds 1200
Close-Splash
L 'done'
