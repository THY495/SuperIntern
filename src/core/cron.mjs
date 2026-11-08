// 定时任务用的 cron：五段（分 时 日 月 星期），按部署时区的墙上时间算。
//   *  a  a-b  */n  a-b/n  a,b,c ；星期 0 与 7 都是周日；另认 @hourly @daily @weekly @monthly
//   日与星期都限定了 → 任一满足即可（与标准 cron 一致）
// 只做"下一次是什么时候"：守护进程拿"上次跑的时间"问它，到点就起草一轮。

import { partsAt, zonedTime } from './tz.mjs';
import { I18nError } from '../i18n/index.mjs';

const ALIAS = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@weekly': '0 0 * * 1', '@monthly': '0 0 1 * *' };
const FIELDS = [['分钟', 0, 59], ['小时', 0, 23], ['日', 1, 31], ['月', 1, 12], ['星期', 0, 7]];
const DAY = 86_400_000;

function field(text, [name, lo, hi]) {
  const out = new Set();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new I18nError('cron 的「{name}」这一段看不懂：{part}', { name, part });
    const step = m[4] ? Number(m[4]) : 1;
    const a = m[1] === '*' ? lo : Number(m[2]);
    const b = m[1] === '*' ? hi : m[3] != null ? Number(m[3]) : m[4] ? hi : a;
    if (a < lo || b > hi || a > b || step < 1) throw new I18nError('cron 的「{name}」超出范围（{lo}–{hi}）：{part}', { name, lo, hi, part });
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** 解析；写错了抛 I18nError（说清哪一段） */
export function parseCron(expr) {
  const src = String(expr ?? '').trim();
  const parts = (ALIAS[src.toLowerCase()] ?? src).split(/\s+/);
  if (parts.length !== 5) throw new I18nError('cron 要五段：分 时 日 月 星期（例如 0 9 * * 1 = 每周一 9:00）');
  const [mi, h, d, mo, wd] = parts.map((p, i) => field(p, FIELDS[i]));
  if (wd.has(7)) wd.add(0);
  return { mi: [...mi].sort((a, b) => a - b), h: [...h].sort((a, b) => a - b), d, mo, wd, anyD: parts[2] === '*', anyWd: parts[4] === '*' };
}

const dayMatches = (c, y, mo, d) => {
  if (!c.mo.has(mo)) return false;
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  if (c.anyD && c.anyWd) return true;
  if (c.anyD) return c.wd.has(wd);
  if (c.anyWd) return c.d.has(d);
  return c.d.has(d) || c.wd.has(wd);
};

/** after 之后（不含）的下一次；400 天内没有（比如 2 月 30 日）→ null */
export function nextRun(expr, after, tz = 'UTC') {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const p = partsAt(after, tz);
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(p.y, p.mo - 1, p.d) + i * DAY);
    const [y, mo, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    if (!dayMatches(c, y, mo, d)) continue;
    for (const h of c.h) for (const mi of c.mi) {
      const t = zonedTime(y, mo, d, h, mi, 0, tz);
      // 夏令时跳过的那一小时会被挪到跳之后：挪出来的时刻若不在这一天了就不算
      if (t > after && partsAt(t, tz).d === d) return t;
    }
  }
  return null;
}

/** 人话：常见的几种直接说，别的原样给 */
export function describeCron(expr, lang = 'zh') {
  const src = String(expr ?? '').trim();
  const s = ALIAS[src.toLowerCase()] ?? src;
  const m = /^(\d+) (\d+) \* \* (\*|[0-7](?:,[0-7])*)$/.exec(s);
  const hm = m ? `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}` : null;
  const zhW = ['日', '一', '二', '三', '四', '五', '六', '日'], enW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (m && m[3] === '*') return lang === 'en' ? `every day at ${hm}` : `每天 ${hm}`;
  if (m) return lang === 'en' ? `every ${m[3].split(',').map((x) => enW[x]).join(', ')} at ${hm}` : `每周${m[3].split(',').map((x) => zhW[x]).join('、')} ${hm}`;
  const mm = /^(\d+) (\d+) (\d+) \* \*$/.exec(s);
  if (mm) return lang === 'en' ? `day ${mm[3]} of every month at ${mm[2].padStart(2, '0')}:${mm[1].padStart(2, '0')}` : `每月 ${mm[3]} 日 ${mm[2].padStart(2, '0')}:${mm[1].padStart(2, '0')}`;
  if (s === '0 * * * *') return lang === 'en' ? 'every hour' : '每小时';
  const ev = /^(?:(\*\/(\d+)) \* \* \* \*|(\d+) \*\/(\d+) \* \* \*)$/.exec(s);
  if (ev?.[2]) return lang === 'en' ? `every ${ev[2]} minutes` : `每 ${ev[2]} 分钟`;
  if (ev?.[4]) return lang === 'en' ? `every ${ev[4]} hours` : `每 ${ev[4]} 小时`;
  return src;
}
