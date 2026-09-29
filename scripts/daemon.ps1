# SuperIntern 守护进程（web --daemon）的 Windows 计划任务：登录即起、崩了不管、日志落 .superintern/logs/daemon.log。
#
#   powershell -ExecutionPolicy Bypass -File scripts/daemon.ps1 install   [-Port 7357] [-Iterations 40]
#   （档位绑定不在这里：常态绑定在库里，看板"绑定"页或 node src/cli.mjs bind set 改；守护进程起的子进程自己读库）
#   powershell -ExecutionPolicy Bypass -File scripts/daemon.ps1 start | stop | status | uninstall
#
# 为什么是计划任务：守护进程曾寄生在编辑器的预览面板里，面板一关它就死了（项目串接 T1 空等一小时）。
# 它得有自己的启动方式，和任何一个窗口都无关。只绑 127.0.0.1，身份 = 本机 CLI 令牌，不改变任何安全边界。
param(
  [Parameter(Position = 0)][ValidateSet('install', 'uninstall', 'start', 'stop', 'status')][string]$Action = 'status',
  [int]$Port = 7357,
  [int]$Iterations = 40
)
$ErrorActionPreference = 'Stop'
$TaskName = 'SuperIntern Daemon'
$Root = Resolve-Path (Join-Path $PSScriptRoot '..')
$Node = (Get-Command node).Source
$LogDir = Join-Path $Root '.superintern\logs'
$Log = Join-Path $LogDir 'daemon.log'
$args = @('src/cli.mjs', 'web', '--daemon', '--port', "$Port", '--iterations', "$Iterations")
# 计划任务不接管 stdout：cmd 重定向到日志文件（追加）。但 cmd 不能直接当动作 —— 交互会话里它会弹窗口，
# 人一关窗口 node 就收到 0xC000013A 死掉（每 5 分钟弹一次、死一次）。经 wscript 以隐藏窗口起（daemon-launch.vbs）。
$Launcher = Join-Path $PSScriptRoot 'daemon-launch.vbs'
$launchArgs = "//B //Nologo `"$Launcher`" `"$Root`" `"$Node`" `"$Log`" $($args -join ' ')"

switch ($Action) {
  'install' {
    New-Item -ItemType Directory -Force $LogDir | Out-Null
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $launchArgs -WorkingDirectory $Root
    # 两个触发器：登录即起；每 5 分钟再试一次（MultipleInstances IgnoreNew：在跑就忽略，没在跑就等于拉活）。
    # 守护进程收到控制台控制事件（0xC000013A）死掉后，RestartCount 并没有把它拉回来 —— 那个开关只管"启动失败"。
    $logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $keepalive = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Hidden -StartWhenAvailable
    $running = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State -eq 'Running'
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger @($logon, $keepalive) -Settings $settings -Force | Out-Null
    if (-not $running) { Start-ScheduledTask -TaskName $TaskName }
    "已安装计划任务 '$TaskName'（登录即起；每 5 分钟拉活一次，在跑则忽略）$(if ($running) { '，已在跑的实例不动' } else { '，已启动' })。日志：$Log"
  }
  'uninstall' {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    "已卸载 '$TaskName'"
  }
  'start' { Start-ScheduledTask -TaskName $TaskName; "已启动" }
  'stop' { Stop-ScheduledTask -TaskName $TaskName; "已停止" }
  'status' {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $t) { "未安装。安装：powershell -ExecutionPolicy Bypass -File scripts/daemon.ps1 install"; break }
    $i = Get-ScheduledTaskInfo -TaskName $TaskName
    "$TaskName：$($t.State)；上次启动 $($i.LastRunTime)；上次结果 $($i.LastTaskResult)"
    if (Test-Path $Log) { Get-Content $Log -Tail 3 }
  }
}
