# 前台启动看板 + 守护进程（Windows）/ Start the web board + daemon in the foreground (Windows)
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1                       单机：只你自己用，开 http://127.0.0.1:7357
#   powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -PublicUrl https://si.example.lan   团队模式（放在 HTTPS 反向代理之后，见 docs/deploy-team.md）
# 想让它登录即起、崩了自动拉：scripts\daemon.ps1 install（见 docs/deploy.md）
param([int]$Port = 7357, [string]$PublicUrl = '')
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$a = @('--disable-warning=ExperimentalWarning', 'src/cli.mjs', 'web', '--daemon', '--port', "$Port")
if ($PublicUrl) { $a += @('--team', '--public-url', $PublicUrl) }
Push-Location $Root; try { & node @a } finally { Pop-Location }
