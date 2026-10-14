// 时间与日历：
//   ① tz.mjs：墙上时间 ↔ 时刻（夏令时跳过 / 重复的那一小时）、加日历日、工作日（周末 / 节假日 / 调休补班）、节假日表解析；
//   ② 业务日按部署时区：没设 = UTC（与升级前逐点一致）；设了 Asia/Shanghai，1bd 落在北京时间的下一个工作日同一时刻；
//   ③ 值班：换班在起点的墙上时刻（跨夏令时不挪一小时）、换班（overrides）优先、旧的值班表（UTC 0 点起点）换算前后一致；
//   ④ 设置校验、月度预算按部署时区翻篇、运行状况里的一项；
//   ⑤ 看板接口：/api/calendar、/api/me 的时区、/api/me/tz、决策路由里按日期与钟点设起点、换班。
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ensureOwner } from '../src/db/db.mjs';
import { addUser } from '../src/core/users.mjs';
import { setSetting } from '../src/core/settings.mjs';
import * as z from '../src/core/tz.mjs';
import { calendarOf, deployTz, viewerTz, calendarHealth } from '../src/core/calendar.mjs';
import { dueAfter, onDutyAt, dutyView, setDutyCalendar, dutyCalendarOf, dutyStartAt, setDutyOverrides, resolveRecipients } from '../src/core/routing.mjs';
import { monthStart, spendByPerson } from '../src/core/spend.mjs';
import { updateUser } from '../src/db/users.mjs';
import { startWeb } from '../src/web/server.mjs';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [PASS] ${m}`); };
const bad = (m, e) => { fail++; console.log(`  [FAIL] ${m}${e !== undefined ? `\n         ${typeof e === 'string' ? e : JSON.stringify(e)}` : ''}`); };
const assert = (c, m, e) => (c ? ok(m) : bad(m, e));
const eq = (a, b, m) => (JSON.stringify(a) === JSON.stringify(b) ? ok(m) : bad(m, `期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`));
const throws = (f, re, m) => { try { f(); bad(m, '没有抛错'); } catch (e) { assert(re.test(String(e.message ?? e)), m, String(e.message ?? e)); } };
const section = (t) => console.log(`\n── ${t}`);

const NY = 'America/New_York', LDN = 'Europe/London', SH = 'Asia/Shanghai';
const iso = (t) => new Date(t).toISOString();
const H = 3600_000, DAY = 86400_000;

const TMP = mkdtempSync(join(tmpdir(), 'si-cal-'));
const HOME = join(TMP, 'home'); mkdirSync(HOME);
const db = openDb(join(HOME, 'state.db'));
const owner = ensureOwner(db, '负责人');
const a = addUser(db, { name: '甲', role: 'member', byUserId: owner.userId });
const b = addUser(db, { name: '乙', role: 'member', byUserId: owner.userId });
const obs = addUser(db, { name: '旁观', role: 'observer', byUserId: owner.userId });

try {
  section('① 墙上时间与时刻');
  {
    eq(iso(z.zonedTime(2026, 10, 12, 9, 0, 0, SH)), '2026-10-12T01:00:00.000Z', '北京时间 9:00 = UTC 1:00');
    eq(z.fmtAt(z.zonedTime(2026, 3, 8, 2, 30, 0, NY), NY), '2026-03-08 03:30 UTC−4', '纽约春季拨快：2:30 不存在 → 挪到跳过之后（3:30 夏令时）');
    eq(iso(z.zonedTime(2026, 11, 1, 1, 30, 0, NY)), '2026-11-01T05:30:00.000Z', '纽约秋季拨回：1:30 出现两次 → 取较早的那次（还是夏令时）');
    eq(iso(z.zonedTime(2026, 3, 29, 1, 30, 0, LDN)), '2026-03-29T01:30:00.000Z', '伦敦春季拨快：1:30 不存在 → 2:30 BST（= 01:30Z）');
    eq(iso(z.zonedTime(2026, 2, 31, 0, 0, 0, 'UTC')), '2026-03-03T00:00:00.000Z', '月日溢出按日历进位（2 月 31 日 = 3 月 3 日）');
    const before = z.zonedTime(2026, 3, 7, 9, 0, 0, NY);
    eq([z.fmtAt(z.addCalendarDays(before, 1, NY), NY), (z.addCalendarDays(before, 1, NY) - before) / H], ['2026-03-08 09:00 UTC−4', 23], '加一个日历日 = 同一个墙上时刻（拨快那天只有 23 小时）');
    const fall = z.zonedTime(2026, 10, 31, 9, 0, 0, NY);
    eq((z.addCalendarDays(fall, 1, NY) - fall) / H, 25, '拨回那天 25 小时');
    eq([z.offsetLabel(Date.UTC(2026, 6, 1), SH), z.offsetLabel(Date.UTC(2026, 6, 1), 'Asia/Kolkata'), z.offsetLabel(Date.UTC(2026, 0, 1), NY), z.offsetLabel(0, 'UTC')], ['UTC+8', 'UTC+5:30', 'UTC−5', 'UTC'], '时区标记');
    eq(z.dayKey(Date.UTC(2026, 9, 11, 17), SH), '2026-10-12', 'UTC 10-11 17:00 在北京已是 10-12');
    eq(iso(z.startOfDay(Date.UTC(2026, 9, 11, 17), SH)), '2026-10-11T16:00:00.000Z', '北京的当天 0 点');
    eq([iso(z.monthStart(Date.UTC(2026, 9, 31, 20), SH)), z.monthKey(Date.UTC(2026, 9, 31, 20), SH)], ['2026-10-31T16:00:00.000Z', '2026-11'], 'UTC 10-31 20:00 在北京已经是 11 月');
    eq([z.validTz(SH), z.validTz('UTC'), z.validTz('Mars/Base'), z.validTz(''), z.validTz('x'.repeat(80))], [true, true, false, false, false], '时区名校验');
  }

  section('② 工作日与节假日表');
  {
    eq(iso(z.addBusinessDays(Date.UTC(2026, 8, 18, 12), 1)), '2026-09-21T12:00:00.000Z', 'UTC、没有节假日：周五 12:00 + 1bd = 周一 12:00（与升级前一致）');
    eq(iso(z.addBusinessDays(Date.UTC(2026, 8, 19, 9), 1)), '2026-09-21T09:00:00.000Z', '周六起算 + 1bd = 周一同一时刻');
    // 与升级前的实现逐点比：任意时刻、1–7 个工作日
    const old = (at, n) => { const d = new Date(at); let left = n; while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) left -= 1; } return d.getTime(); };
    let diff = 0;
    for (let i = 0; i < 400; i++) { const t = Date.UTC(2026, 0, 1) + i * 21.7 * H; for (let n = 1; n <= 7; n++) if (old(t, n) !== z.addBusinessDays(t, n)) diff++; }
    eq(diff, 0, '不设部署时区：400 个时刻 × 1–7bd 与旧实现完全一致');
    const fri = z.zonedTime(2026, 3, 6, 9, 0, 0, NY);
    eq(z.fmtAt(z.addBusinessDays(fri, 1, { tz: NY }), NY), '2026-03-09 09:00 UTC−4', '纽约：周五 9:00 + 1bd 跨过拨快 = 周一 9:00（不是 10:00）');
    const h = z.parseHolidays('# 2026 国庆\n2026-10-01..2026-10-07 国庆\n2026-10-11 班 国庆调休\n2026-9-27 work\n\n2027-01-01 元旦');
    eq([h.off.size, [...h.on].sort(), h.last, h.errors.length, h.names.get('2026-10-03')], [8, ['2026-09-27', '2026-10-11'], '2027-01-01', 0, '国庆'], '解析：区间、补班（班 / work）、不补零的日期、注释与空行');
    const e = z.parseHolidays('2026-02-30\n2026-10-07..2026-10-01\n2026-01-01..2026-12-31\n国庆');
    eq(e.errors.map((x) => [x.line, x.why]), [[1, 'date'], [2, 'order'], [3, 'span'], [4, 'format']], '解析错误带行号与原因');
    const cal = { tz: SH, ...h };
    const sep30 = z.zonedTime(2026, 9, 30, 10, 0, 0, SH);
    eq([z.fmtAt(z.addBusinessDays(sep30, 1, cal), SH), z.fmtAt(z.addBusinessDays(sep30, 2, cal), SH)], ['2026-10-08 10:00 UTC+8', '2026-10-09 10:00 UTC+8'], '国庆：9-30 10:00 + 1bd = 10-08，+ 2bd = 10-09');
    const oct9 = z.zonedTime(2026, 10, 9, 15, 0, 0, SH);
    eq(z.fmtAt(z.addBusinessDays(oct9, 1, cal), SH), '2026-10-11 15:00 UTC+8', '调休：10-09（周五）+ 1bd = 10-11（周日补班）');
    eq([z.isBusinessDay('2026-10-11', cal), z.isBusinessDay('2026-10-05', cal), z.isBusinessDay('2026-10-10', cal)], [true, false, false], '补班 > 放假 > 周末');
    eq(z.addBusinessDays(0, 3, { tz: 'UTC', off: { has: () => true }, on: new Set() }) > 0, true, '节假日表把所有日子都标成放假：不死循环');
  }

  section('③ 部署时区：设置、业务日、月度预算');
  {
    eq([deployTz(db), calendarOf(db).tz], ['UTC', 'UTC'], '没设 = UTC');
    throws(() => setSetting(db, { key: 'deploy.timezone', value: 'Mars/Base', userId: owner.userId }), /不认识的时区/, '不认识的时区拒收');
    throws(() => setSetting(db, { key: 'deploy.holidays', value: '2026-10-01 国庆\n十月一日', userId: owner.userId }), /1 行看不懂.*2: 十月一日/, '节假日表有看不懂的行：拒收，报行号与原文');
    const t0 = Date.UTC(2026, 8, 30, 2);   // 北京 9-30 10:00
    eq(iso(dueAfter(t0, '1bd', calendarOf(db))), '2026-10-01T02:00:00.000Z', '没设时区与节假日：1bd = 第二天同一时刻（UTC 周四）');
    setSetting(db, { key: 'deploy.timezone', value: ` ${SH} `, userId: owner.userId });
    setSetting(db, { key: 'deploy.holidays', value: '2026-10-01..2026-10-07 国庆\n2026-10-11 班', userId: owner.userId });
    eq(deployTz(db), SH, '设了部署时区（去首尾空白）');
    eq(z.fmtAt(dueAfter(t0, '1bd', calendarOf(db)), SH), '2026-10-08 10:00 UTC+8', '设了时区与国庆：1bd 落到 10-08 同一时刻');
    eq([dueAfter(t0, '8h', calendarOf(db)) - t0, dueAfter(t0, '1d', calendarOf(db)) - t0], [8 * H, DAY], 'h / d 仍是固定时长');
    eq(iso(monthStart(Date.UTC(2026, 9, 31, 20), 0, deployTz(db))), '2026-10-31T16:00:00.000Z', '月度预算按部署时区翻篇（北京 11-01 0 点）');
    eq([spendByPerson(db, { at: Date.UTC(2026, 9, 31, 20) }).month, spendByPerson(db, { at: Date.UTC(2026, 9, 31, 20) }).tz], ['2026-11', SH], '花费页的"本月"按部署时区');
    eq(viewerTz(db, a.userId), SH, '成员没设自己的时区 → 跟部署时区');
    updateUser(db, a.userId, { tz: NY });
    eq(viewerTz(db, a.userId), NY, '成员设了自己的时区 → 给他看的按他的');
    updateUser(db, a.userId, { tz: null });
  }

  section('④ 值班：换班时刻、夏令时、换班（overrides）');
  {
    // 旧的值班表：起点是 UTC 0 点（看板原来把日期当 UTC 解析）。换成部署时区后，换班仍在同一个时刻（北京 8:00 = UTC 0:00）
    const oldStart = Date.UTC(2026, 8, 21);
    const legacy = { users: [a.userId, b.userId], start_at: oldStart, period_days: 7 };
    const oldOnDuty = (cal, at) => { const idx = Math.floor((at - cal.start_at) / (cal.period_days * DAY)); return cal.users[((idx % cal.users.length) + cal.users.length) % cal.users.length]; };
    let diff = 0;
    for (let i = -200; i < 400; i++) { const t = oldStart + i * 7.3 * H; if (oldOnDuty(legacy, t) !== onDutyAt({ ...legacy, tz: SH }, t) || oldOnDuty(legacy, t) !== onDutyAt({ ...legacy, tz: 'UTC' }, t)) diff++; }
    eq(diff, 0, '升级前设的值班表：按 UTC 与按北京时间算，600 个时刻谁值班都与旧算法一致');

    setDutyCalendar(db, { key: '', users: [a.userId, b.userId], startAt: dutyStartAt(db, '2026-10-05', '09:00'), periodDays: 7, userId: owner.userId });
    const cal = dutyCalendarOf(db, '');
    eq([cal.tz, cal.startDay, cal.startTime], [SH, '2026-10-05', '09:00'], '起点按部署时区的日期与钟点存、按它读回');
    const at = (d, h, m = 0) => z.zonedTime(2026, 10, d, h, m, 0, SH);
    eq([onDutyAt(cal, at(5, 9)), onDutyAt(cal, at(12, 8, 59)), onDutyAt(cal, at(12, 9)), onDutyAt(cal, at(19, 9))], [a.userId, a.userId, b.userId, a.userId], '每 7 天在 9:00 换班（8:59 还是上一位）');
    eq(onDutyAt(cal, at(5, 8, 59)), b.userId, '起点之前倒着轮');

    // 夏令时：纽约，每周一 9:00 换班；跨过 3 月拨快，换班仍在 9:00
    const ny = { users: [a.userId, b.userId], start_at: z.zonedTime(2026, 3, 2, 9, 0, 0, NY), period_days: 7, tz: NY };
    eq([onDutyAt(ny, z.zonedTime(2026, 3, 9, 8, 30, 0, NY)), onDutyAt(ny, z.zonedTime(2026, 3, 9, 9, 0, 0, NY))], [a.userId, b.userId], '纽约跨过拨快：3-9 8:30 还是甲，9:00 换成乙（按毫秒算会晚一小时）');
    eq([onDutyAt(ny, z.zonedTime(2026, 11, 2, 8, 59, 0, NY)), onDutyAt(ny, z.zonedTime(2026, 11, 2, 9, 0, 0, NY))], [a.userId, b.userId], '跨过拨回：11-2（第 35 周）仍是 9:00 换班');

    // 换班
    throws(() => setDutyOverrides(db, { key: 'nope', overrides: [], userId: owner.userId }), /还没有值班表/, '没有值班表不能加换班');
    throws(() => setDutyOverrides(db, { key: '', overrides: [{ from: '2026-10-14', to: '2026-10-13', user: a.userId }], userId: owner.userId }), /日期无效/, '止早于起：拒');
    throws(() => setDutyOverrides(db, { key: '', overrides: [{ from: '2026-10-13', user: obs.userId }], userId: owner.userId }), /旁观者/, '旁观者不能值班');
    const saved = setDutyOverrides(db, { key: '', overrides: [{ from: '2026-10-13', to: '2026-10-14', user: a.userId, note: ' 乙请假\u0007 ' }, { from: '2026-10-14', user: owner.userId }], userId: owner.userId });
    eq(saved, [{ from: '2026-10-13', to: '2026-10-14', user: a.userId, note: '乙请假' }, { from: '2026-10-14', to: '2026-10-14', user: owner.userId }], '换班：只给一天 = 当天；说明去控制字符');
    const c2 = dutyCalendarOf(db, '');
    eq([onDutyAt(c2, at(13, 0, 30)), onDutyAt(c2, at(13, 23)), onDutyAt(c2, at(14, 10)), onDutyAt(c2, at(15, 0, 1))], [a.userId, a.userId, owner.userId, b.userId], '换班按部署时区的整天；重叠时后写的优先；过了就回到轮换');
    eq(resolveRecipients(db, '', ['on_duty'], { at: at(13, 12) }).answerers, [a.userId], 'on_duty 解析器认换班');
    eq(db.one(`SELECT count(*) n FROM audit_log WHERE action='duty_overrides_set'`).n, 1, '换班记审计');

    // 值班表的结果（看板 / 命令行显示用）：原来"写着张三出差、那几天其实轮到李四"看不出来
    const v = dutyView(db, '', at(13, 12));
    eq([v.now.user, !!v.now.override, v.now.rotationUser], [a.userId, true, b.userId], '此刻：代班的人，并写出轮换本该是谁');
    eq(v.covers, [[b.userId], [b.userId]], '每条代班替的是谁：那几天按轮换本来值班的人（这里两条都是乙，不是说明里以为的人）');
    eq(v.next.slice(0, 2).map((n) => [n.user, z.fmtAt(n.at, SH)]), [[a.userId, '2026-10-19 09:00 UTC+8'], [b.userId, '2026-10-26 09:00 UTC+8']], '接下来的交接：按起点钟点、按部署时区');
    eq(v.used, false, '默认路由表没有哪一行用值班人 → 标出值班表不起作用');
    const v2 = dutyView(db, '', at(12, 9));
    eq([v2.now.user, v2.now.override, v2.next[0].user], [b.userId, null, a.userId], '没代班时：此刻就是轮换到的人，下一位是轮换的下一位');
  }

  section('⑤ 运行状况');
  {
    const h = calendarHealth(db, Date.UTC(2026, 9, 5));
    eq([h.key, h.level, h.tz, h.set, h.holidaysUntil, h.stale, h.ending, h.daysLeft], ['calendar', 'warn', SH, true, '2026-10-11', false, true, 6], '节假日表 6 天后就到头 → 注意（那以后的放假日会当工作日）');
    const far = calendarHealth(db, Date.UTC(2026, 7, 1));
    eq([far.level, far.ending, far.daysLeft], ['ok', false, 71], '还剩 71 天（≥ 60）→ 正常');
    eq([calendarHealth(db, Date.UTC(2026, 11, 1)).level, calendarHealth(db, Date.UTC(2026, 11, 1)).stale], ['warn', true], '节假日表最后一天已过 → 注意');
  }

  section('⑥ 看板接口');
  {
    const PUB = 'si.cal.lan';
    const w = await startWeb(db, { home: HOME, port: 0, tokenPlain: owner.plaintext, pollMs: 100, team: true, publicUrl: `https://${PUB}`, runtime: { current: () => null } });
    const call = (method, path, { headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
      const data = body === null ? null : JSON.stringify(body);
      const r = request({ host: '127.0.0.1', port: w.port, method, path, headers: { host: PUB, origin: `https://${PUB}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch { j = s; } resolve({ status: res.statusCode, body: j }); });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
    const as = (tok) => ({ 'x-superintern-token': tok });
    try {
      let r = await call('GET', '/api/calendar', { headers: as(b.plaintext) });
      eq([r.status, r.body.tz, r.body.set, typeof r.body.now, Array.isArray(r.body.upcoming)], [200, SH, true, 'string', true], '/api/calendar：成员能看');
      eq((await call('GET', '/api/calendar')).status, 401, '/api/calendar：不带凭证 401');
      r = await call('GET', '/api/me', { headers: as(b.plaintext) });
      eq([r.body.tz, r.body.ownTz, r.body.deployTz], [SH, null, SH], '/api/me：没设自己的时区 → 跟部署时区');
      r = await call('POST', '/api/me/tz', { headers: as(b.plaintext), body: { tz: 'Nowhere/City' } });
      eq(r.status, 400, '/api/me/tz：不认识的时区 400');
      r = await call('POST', '/api/me/tz', { headers: as(b.plaintext), body: { tz: NY } });
      eq([r.status, r.body.tz, (await call('GET', '/api/me', { headers: as(b.plaintext) })).body.tz], [200, NY, NY], '/api/me/tz：改自己的');
      r = await call('POST', '/api/me/tz', { headers: as(b.plaintext), body: { tz: '' } });
      eq(r.body.tz, SH, '/api/me/tz：清掉 → 跟部署时区');

      const ver = (await call('GET', '/api/routing', { headers: as(owner.plaintext) })).body.version;
      r = await call('POST', '/api/routing', { headers: as(owner.plaintext), body: { action: 'duty', version: ver, users: [b.userId, a.userId], startDay: '2026-11-02', startTime: '10:30', periodDays: 14 } });
      eq([r.status, r.body.result?.startDay, r.body.result?.startTime, r.body.result?.period_days], [200, '2026-11-02', '10:30', 14], '决策路由：按部署时区的日期与钟点设值班起点');
      r = await call('POST', '/api/routing', { headers: as(owner.plaintext), body: { action: 'duty', version: r.body.version, users: [a.userId], startDay: '2026-11-31', startTime: '10:30' } });
      eq(r.status >= 400, true, '不存在的日期拒收');
      const v2 = (await call('GET', '/api/routing', { headers: as(owner.plaintext) })).body.version;
      r = await call('POST', '/api/routing', { headers: as(owner.plaintext), body: { action: 'dutyOverrides', version: v2, overrides: [{ from: '2026-11-05', user: a.userId, note: '代班' }] } });
      eq([r.status, r.body.result?.overrides], [200, [{ from: '2026-11-05', to: '2026-11-05', user: a.userId, note: '代班' }]], '决策路由：加换班');
      r = await call('POST', '/api/routing', { headers: as(b.plaintext), body: { action: 'dutyOverrides', version: r.body.version, overrides: [] } });
      eq(r.status, 403, '成员不能改默认表的换班');
      const dv = (await call('GET', '/api/routing', { headers: as(owner.plaintext) })).body.dutyView;
      eq([typeof dv?.now?.user, dv?.covers?.length, dv?.next?.length, typeof dv?.used], ['string', 1, 4, 'boolean'], '决策路由接口带上值班表的结果（此刻谁值、接下来、代班替谁、有没有被用上）');
    } finally { await w.close?.(); }
  }
} catch (e) {
  bad('意外异常', e.stack);
} finally {
  db.close();
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
}

console.log(`\n${'═'.repeat(72)}\n${fail ? '❌' : '✅'} ${pass} 通过，${fail} 失败\n${'═'.repeat(72)}`);
process.exit(fail ? 1 : 0);
