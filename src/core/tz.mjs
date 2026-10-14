// 时区与日历：业务日、值班换班、月度预算按「部署时区」算，显示按看的人的时区。
//
// 原来全部按 UTC：`1bd`（一个工作日）在中国部署上是"北京时间早 8 点换天"，值班表"从 9 月 21 日起"实际是 21 日早 8 点换班，
// 月度预算 1 日早 8 点才翻篇；看板显示浏览器本地时间不标时区，命令行 / 提交 / PR 是 UTC，对照着看差 8 小时。
//
// 只用 Node 自带的 Intl（完整 ICU，时区库随 Node 更新），不带第三方时区库。
// 夏令时：日历运算按"墙上时间"走 —— 加一天 = 同一个墙上时刻的下一天（不是 +24 小时）；墙上时刻在跳过的那一小时里（春季拨快）
// 往后挪到跳过之后，在重复的那一小时里（秋季拨回）取较早的那次。
//
// 节假日：部署级一张表（文字，一行一条），「休」的日子不算工作日，「班」的日子（调休补班）周末也算工作日。

const DAY = 86400_000;
const fmtCache = new Map();
function dtf(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 是不是 IANA 时区名（Asia/Shanghai、America/New_York、UTC……） */
export function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
/** 服务器本机的时区（拿不到时当 UTC） */
export const systemTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** 某一时刻在某时区的墙上时间：{ y, mo(1–12), d, h, mi, s, wd(0=周日) } */
export function partsAt(at, tz = 'UTC') {
  const p = {};
  for (const x of dtf(tz).formatToParts(new Date(at))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
}
/** 某一时刻该时区相对 UTC 的偏移（毫秒；东八区 = +8h） */
export function offsetAt(at, tz = 'UTC') {
  const p = partsAt(at, tz);
  const t = Math.floor(at / 1000) * 1000;
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t;
}
const sameWall = (at, tz, y, mo, d, h, mi, s) => { const p = partsAt(at, tz); return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi && p.s === s; };

/** 墙上时间 → 时刻。跳过的那一小时往后挪；重复的那一小时取较早的。月日溢出按 Date.UTC 的规则进位（d = 32 → 下个月）。 */
export function zonedTime(y, mo, d, h = 0, mi = 0, s = 0, tz = 'UTC') {
  const n = new Date(Date.UTC(y, mo - 1, d, h, mi, s));   // 先归一化（进位）
  [y, mo, d, h, mi, s] = [n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), n.getUTCHours(), n.getUTCMinutes(), n.getUTCSeconds()];
  const guess = n.getTime();
  const before = offsetAt(guess - DAY, tz), after = offsetAt(guess + DAY, tz);
  const cands = [...new Set([guess - before, guess - after])].filter((t) => sameWall(t, tz, y, mo, d, h, mi, s)).sort((a, b) => a - b);
  if (cands.length) return cands[0];
  return guess - before;   // 落在跳过的那一小时里：按跳之前的偏移算，结果在跳过之后
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/** 时刻在该时区是哪一天：'YYYY-MM-DD' */
export const dayKey = (at, tz = 'UTC') => { const p = partsAt(at, tz); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
/** 'YYYY-MM-DD' 是星期几（0 = 周日；与时区无关） */
export const weekdayOfKey = (k) => new Date(`${k}T00:00:00Z`).getUTCDay();
/** 日期串校验（真实存在的日子） */
export const validDayKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && new Date(`${k}T00:00:00Z`).toISOString().slice(0, 10) === k;
/** 两个日期串之间差几天（b − a） */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
/** 日期串加 n 天 */
export const addDaysKey = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** 同一个墙上时刻往后（前）n 个日历日。夏令时那天不是 ±24 小时。 */
export function addCalendarDays(at, n, tz = 'UTC') {
  const p = partsAt(at, tz);
  return zonedTime(p.y, p.mo, p.d + n, p.h, p.mi, p.s, tz) + (((at % 1000) + 1000) % 1000);
}
/** 该时区某一天 00:00 的时刻（那天 0 点被跳过的话取当天最早的时刻） */
export function startOfDay(at, tz = 'UTC') { const p = partsAt(at, tz); return zonedTime(p.y, p.mo, p.d, 0, 0, 0, tz); }
/** 该时区某月 1 日 00:00；back = 往前几个月（负数 = 往后） */
export function monthStart(at, tz = 'UTC', back = 0) { const p = partsAt(at, tz); return zonedTime(p.y, p.mo - back, 1, 0, 0, 0, tz); }
/** 'YYYY-MM' */
export const monthKey = (at, tz = 'UTC') => { const p = partsAt(at, tz); return `${p.y}-${pad(p.mo)}`; };

/** 偏移写成 UTC+8 / UTC−5 / UTC+5:30 / UTC */
export function offsetLabel(at, tz = 'UTC') {
  const o = Math.round(offsetAt(at, tz) / 60_000);
  if (!o) return 'UTC';
  const a = Math.abs(o);
  return `UTC${o > 0 ? '+' : '−'}${Math.floor(a / 60)}${a % 60 ? `:${pad(a % 60)}` : ''}`;
}
/** 命令行 / 摘要用的时刻：'2026-10-12 14:03 UTC+8'（seconds: true 带秒） */
export function fmtAt(at, tz = 'UTC', { seconds = false, zone = true } = {}) {
  if (at == null || !Number.isFinite(Number(at))) return '';
  const p = partsAt(Number(at), tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}${seconds ? `:${pad(p.s)}` : ''}${zone ? ` ${offsetLabel(Number(at), tz)}` : ''}`;
}

// ── 节假日表 ───────────────────────────────────────────────────────────────
// 一行一条：`2026-10-01..2026-10-07 国庆`（休）、`2026-10-11 班 国庆调休`（补班）。`..` 也可以写 `~` 或 `至`。
// `#` 之后是注释。日期后面任何位置出现「班 / 上班 / 补班 / work / workday」= 补班，否则 = 休。
const WORK_WORDS = new Set(['班', '上班', '补班', 'work', 'workday', 'working']);
export const HOLIDAY_MAX_SPAN = 62;

/** 文字 → { off: Set, on: Set, names: Map(day → 名字), last: 最后一天 | null, errors: [{ line, text, why }] } */
export function parseHolidays(text) {
  const off = new Set(), on = new Set(), names = new Map(), errors = [];
  let last = null;
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = /^(\d{4}-\d{1,2}-\d{1,2})(?:\s*(?:\.\.|~|～|至|–|—)\s*(\d{4}-\d{1,2}-\d{1,2}))?(?:\s+(.*))?$/.exec(line);
    const norm = (k) => (k ? k.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (_, y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`) : k);
    if (!m) { errors.push({ line: i + 1, text: raw.trim(), why: 'format' }); return; }
    const a = norm(m[1]), b = norm(m[2]) ?? a;
    if (!validDayKey(a) || !validDayKey(b)) { errors.push({ line: i + 1, text: raw.trim(), why: 'date' }); return; }
    const span = daysBetween(a, b);
    if (span < 0) { errors.push({ line: i + 1, text: raw.trim(), why: 'order' }); return; }
    if (span >= HOLIDAY_MAX_SPAN) { errors.push({ line: i + 1, text: raw.trim(), why: 'span' }); return; }
    const words = (m[3] ?? '').split(/\s+/).filter(Boolean);
    const work = words.some((w) => WORK_WORDS.has(w.toLowerCase()));
    const name = words.filter((w) => !WORK_WORDS.has(w.toLowerCase())).join(' ');
    for (let k = a, n = 0; n <= span; n++, k = addDaysKey(k, 1)) {
      (work ? on : off).add(k); (work ? off : on).delete(k);
      if (name) names.set(k, name);
      if (!last || k > last) last = k;
    }
  });
  return { off, on, names, last, errors };
}

/** 是不是工作日：补班 > 休 > 周末 */
export function isBusinessDay(k, cal) {
  if (cal?.on?.has(k)) return true;
  if (cal?.off?.has(k)) return false;
  const wd = weekdayOfKey(k);
  return wd !== 0 && wd !== 6;
}
export const UTC_CALENDAR = Object.freeze({ tz: 'UTC', off: new Set(), on: new Set(), names: new Map(), last: null });

/** 往后 n 个工作日：同一个墙上时刻，落在下一个（第 n 个）工作日上。起点是不是工作日不影响（周六 + 1 = 周一同一时刻）。 */
export function addBusinessDays(at, n, cal = UTC_CALENDAR) {
  const tz = cal?.tz ?? 'UTC';
  let t = at, k = 0, guard = 0;
  while (k < n) {
    t = addCalendarDays(t, 1, tz);
    if (isBusinessDay(dayKey(t, tz), cal)) k++;
    if (++guard > 3660) break;   // 节假日表把十年都标成休了：不死循环
  }
  return t;
}

export const _test = { dtf };
