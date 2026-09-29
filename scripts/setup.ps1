# 首次安装（Windows）/ First-time setup (Windows)
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 [-Name <管理员名字>]
param([string]$Name = '')
$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host '没有 Node.js：请先装 Node 22.13 或更新版本 / Node.js not found: install Node >= 22.13 (https://nodejs.org)'; exit 1 }
$v = (& node -p "process.versions.node").Trim()
$parts = $v.Split('.') | ForEach-Object { [int]$_ }
if ($parts[0] -lt 22 -or ($parts[0] -eq 22 -and $parts[1] -lt 13)) { Write-Host "Node $v 太旧，需要 >= 22.13 / Node $v is too old, need >= 22.13"; exit 1 }
$a = @('scripts/setup.mjs'); if ($Name) { $a += @('--name', $Name) }
Push-Location $Root; try { & node @a; exit $LASTEXITCODE } finally { Pop-Location }
