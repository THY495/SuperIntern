' 无窗口启动器：计划任务的动作原来是 cmd.exe /c ...，在交互会话里每次触发都弹一个 cmd 窗口，
' 而人一关那个窗口，node 就收到控制台控制事件（0xC000013A）死掉 —— 5 分钟后再弹、再死。
' wscript 以窗口样式 0（隐藏）起 cmd，重定向照旧；没有窗口，也就没人能顺手关掉它。
' 必须**等待**（第三个参数 True）：计划任务在动作进程退出时回收整个 job object，node 会跟着收到 ^C 死掉
' （不等待的版本起来 1 秒就会被收掉）。等着，任务就一直是 Running，5 分钟触发器在跑时被忽略、死了才拉。
' 参数：<root> <node.exe> <log> <node 参数...>
Set sh = CreateObject("WScript.Shell")
Set a = WScript.Arguments
If a.Count < 4 Then WScript.Quit 2
root = a(0) : node = a(1) : logFile = a(2)
rest = ""
For i = 3 To a.Count - 1
  rest = rest & " " & a(i)
Next
cmd = "cmd.exe /c ""cd /d """ & root & """ && """ & node & """" & rest & " >> """ & logFile & """ 2>&1"""
WScript.Quit sh.Run(cmd, 0, True)
