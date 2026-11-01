# Claw Studio 卸载：删除快捷方式，停止服务；可选删除本地数据（改名/置顶、上传文件、窗口配置）
# 不会动 Genspark Claw 本身和你的聊天记录
$links = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claw Studio.lnk'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Claw Studio.lnk'))
foreach ($l in $links) { if (Test-Path $l) { Remove-Item $l; Write-Host "已删除 $l" } }
$port = if ($env:CLAW_STUDIO_PORT) { [int]$env:CLAW_STUDIO_PORT } else { 28900 }
$p = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($p) { Stop-Process -Id $p -Force; Write-Host '已停止 Claw Studio 服务' }
$data = Join-Path $env:LOCALAPPDATA 'ClawStudio'
if ((Test-Path $data) -and ((Read-Host "删除本地数据 $data ？（改名/置顶、上传的附件、窗口设置）(y/N)") -eq 'y')) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($data, 'OnlyErrorDialogs', 'SendToRecycleBin'); Write-Host '已移到回收站'
}
Write-Host '卸载完成。程序文件夹可以直接删除。'
