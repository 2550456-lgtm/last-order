# 开发期截图助手（不属于产品代码）
# 用法: pwsh -File scripts/shot.ps1 -Url "http://127.0.0.1:8788/?nosse=1#/match" -Out shots/match.png -Height 2400
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Height = 2000,
  [int]$Width = 1440,
  [int]$WaitSec = 12
)

$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edge)) { throw "找不到 Edge: $edge" }

$outPath = [System.IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($outPath)) | Out-Null
if (Test-Path $outPath) { Remove-Item $outPath -Force }

$udd = Join-Path $env:TEMP ("edge-shot-" + [guid]::NewGuid().ToString('N'))
$p = Start-Process -FilePath $edge -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', "--user-data-dir=$udd",
  '--hide-scrollbars', "--window-size=$Width,$Height", '--virtual-time-budget=4000',
  "--screenshot=$outPath", $Url
)
Start-Sleep -Seconds $WaitSec
if (-not $p.HasExited) { $p.Kill() }
Start-Sleep -Milliseconds 400
Remove-Item $udd -Recurse -Force -ErrorAction SilentlyContinue

if (Test-Path $outPath) {
  "OK  $outPath  $((Get-Item $outPath).Length) bytes"
} else {
  "FAIL 没有生成截图"
  exit 1
}
