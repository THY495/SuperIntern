// Windows 上子进程默认不弹窗（否则会弹出一大串 terminal 窗口）。
//
// 看板 + 守护进程常常由没有控制台的父进程拉起（桌面应用、计划任务、服务）。这样的进程每调一次 git / docker / node，
// Windows 都给子进程新开一个控制台；默认终端是 Windows Terminal 时它就是一个弹出来又关掉的窗口 —— 一个任务能闪几十次。
// Node 的 windowsHide 默认是 false，代码里几十处 execFileSync 一处处加既容易漏、以后新写的也会漏，
// 所以在入口处统一把默认值改成 true（显式写了 windowsHide 的照旧）。非 Windows 什么也不做。
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

if (process.platform === 'win32' && !cp.__siWindowsHide) {
  // 找到选项对象就补上 windowsHide；没有就插一个（在参数数组之后、回调之前）
  const withHide = (a) => {
    const i = a.findIndex((x, k) => k > 0 && x && typeof x === 'object' && !Array.isArray(x));
    if (i >= 0) { if (!('windowsHide' in a[i])) a[i] = { ...a[i], windowsHide: true }; return a; }
    a.splice(Array.isArray(a[1]) ? 2 : 1, 0, { windowsHide: true });
    return a;
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    const orig = cp[name];
    const wrapped = function (...a) { return orig.apply(this, withHide(a)); };
    if (orig[promisify.custom]) wrapped[promisify.custom] = (...a) => orig[promisify.custom](...withHide(a));
    cp[name] = wrapped;
  }
  cp.__siWindowsHide = true;
  // 让 `import { execFileSync } from 'node:child_process'` 的具名导入也换成包过的版本
  syncBuiltinESMExports();
}
