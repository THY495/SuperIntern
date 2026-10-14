// 部署的时区与节假日。算法在 tz.mjs；这里只是"从库里读出这台部署的日历"。
//
// 部署时区没设 = UTC（升级前的行为，一点不变）；看板「运行状况」在服务器本机不是 UTC 时提示去设。
// 成员时区（users.tz）只影响给他看的时刻；业务日、值班换班、月度预算一律按部署时区。

import { getSetting } from './settings.mjs';
import { parseHolidays, validTz, systemTz, offsetAt, dayKey, fmtAt, daysBetween } from './tz.mjs';

/** 节假日表剩不到这么多天就在运行状况里提醒补下一段 */
export const HOLIDAY_WARN_DAYS = 60;

/** 部署时区（没设 = UTC） */
export const deployTz = (db) => { const z = getSetting(db, 'deploy.timezone'); return z && validTz(z) ? z : 'UTC'; };

let cache = { text: null, parsed: null };
/** 部署日历：{ tz, off, on, names, last }（节假日表按文字缓存解析结果） */
export function calendarOf(db) {
  const text = getSetting(db, 'deploy.holidays') ?? '';
  if (cache.text !== text) cache = { text, parsed: parseHolidays(text) };
  const { off, on, names, last } = cache.parsed;
  return { tz: deployTz(db), off, on, names, last };
}

/** 给某人看的时区：他自己设的 → 部署的 */
export function viewerTz(db, userId) {
  const z = userId ? db.one(`SELECT tz FROM users WHERE id=?`, userId)?.tz : null;
  return z && validTz(z) ? z : deployTz(db);
}

/** 运行状况里的一项：部署时区与节假日表 */
export function calendarHealth(db, at = Date.now()) {
  const set = getSetting(db, 'deploy.timezone') || null;
  const sys = systemTz();
  const cal = calendarOf(db);
  const today = dayKey(at, cal.tz);
  const holidays = (getSetting(db, 'deploy.holidays') ?? '').trim() !== '';
  // 没设部署时区而服务器本机不是 UTC：业务日、换班、月初都按 UTC 算，差了本机的时差 —— 这正是 时间与日历要修的事，提醒去设
  const unsetButLocal = !set && offsetAt(at, sys) !== 0;
  const stale = holidays && cal.last && cal.last < today;
  // 快排到头了（不到 60 天）：那以后的放假日都会当工作日 —— 看到"正常"的人会以为之后的长假已经算进去了
  const daysLeft = holidays && cal.last && !stale ? daysBetween(today, cal.last) : null;
  const ending = daysLeft != null && daysLeft < HOLIDAY_WARN_DAYS;
  return { key: 'calendar', level: unsetButLocal || stale || ending ? 'warn' : 'ok', ending, daysLeft, tz: cal.tz, set: !!set, systemTz: sys, systemOffsetMin: Math.round(offsetAt(at, sys) / 60_000),
    now: fmtAt(at, cal.tz), holidays, holidaysUntil: cal.last, holidayDays: cal.off.size, workdays: cal.on.size, stale: !!stale };
}
