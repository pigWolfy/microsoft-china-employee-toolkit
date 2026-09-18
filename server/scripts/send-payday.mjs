#!/usr/bin/env node
/**
 * send-payday.mjs — 发薪日 Web Push 定时推送
 *
 * 每日由 cron 运行。逻辑：
 *   - 计算微软本月工资发放日 = 每月倒数第三个工作日（仅排除周末，法定假日以 HR 通知为准）
 *   - 发薪日前一天(T-1)、发薪日当天(T-0) 各推送一次
 *   - 其余日期直接安静退出（除非 PUSH_FORCE=1 测试）
 *   - 读取 ${BENEFITS_DATA_DIR}/push-subscriptions.jsonl（与 /api/push 同一文件）
 *   - 对 404/410 的失效订阅自动清理
 *
 * 必需 env:
 *   VAPID_PUBLIC_KEY   VAPID_PRIVATE_KEY
 * 可选 env:
 *   VAPID_SUBJECT           必填
 *   SUBSCRIPTIONS_FILE      默认 ${BENEFITS_DATA_DIR}/push-subscriptions.jsonl
 *   PAGE_URL                必填，指向本部署的页面
 *   PUSH_FORCE=1            忽略日期判断，强制推一条（测试用）
 *   PUSH_DRY=1              只打印不发送
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || '';
const DATA_DIR = process.env.BENEFITS_DATA_DIR || path.join(process.cwd(), 'data');
const SUB_FILE = process.env.SUBSCRIPTIONS_FILE || path.join(DATA_DIR, 'push-subscriptions.jsonl');
const PAGE_URL = process.env.PAGE_URL || '';
const FORCE = process.env.PUSH_FORCE === '1';
const DRY = process.env.PUSH_DRY === '1';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

if (!PUBLIC_KEY || !PRIVATE_KEY || !SUBJECT || !PAGE_URL) {
  console.error('ERROR: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT and PAGE_URL are required');
  process.exit(1);
}
webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

/** 每月倒数第 n 个工作日 */
function getNthLastBizDay(year, month, n) {
  const d = new Date(year, month + 1, 0); // 当月最后一天
  let count = 0;
  while (count < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) count++;
    if (count < n) d.setDate(d.getDate() - 1);
  }
  return d;
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function fmt(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）`;
}

function daysBetween(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

/** 距今最近的、尚未过去的发薪日（本月未过取本月，否则取下月） */
function getUpcomingPayday(now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let p = getNthLastBizDay(now.getFullYear(), now.getMonth(), 3);
  if (p < today) {
    const nm = now.getMonth() + 1;
    p = getNthLastBizDay(nm > 11 ? now.getFullYear() + 1 : now.getFullYear(), nm % 12, 3);
  }
  return p;
}

/**
 * 根据用户偏好，算出针对发薪日 P 应该在哪天提醒。
 * - dom 为 null：默认 = 发薪日前一天
 * - dom 有值：每月固定第 dom 号；若 dom 晚于发薪日当天，则改为发薪日当天提醒
 */
function reminderDateFor(prefs, P) {
  const dom = prefs && prefs.dom != null ? prefs.dom : null;
  if (dom == null) {
    const r = new Date(P);
    r.setDate(r.getDate() - 1);
    return r;
  }
  if (dom > P.getDate()) return new Date(P); // 晚于发薪日 → 发薪日当天
  return new Date(P.getFullYear(), P.getMonth(), dom);
}

/** 根据发薪日 P 与今天，生成通知文案（App 名由系统展示，title 为订阅类型，body 为正文） */
function buildMessage(P, today) {
  const d = daysBetween(today, P);
  let body;
  if (d === 0) body = `微软本月发薪日就是今天 ${fmt(P)}，记得查看到账～`;
  else if (d === 1) body = `微软本月发薪日是明天 ${fmt(P)}，先高兴一下🎉`;
  else body = `微软本月发薪日 ${fmt(P)}，还有 ${d} 天。`;
  return { title: '发薪日提醒', body, url: PAGE_URL, tag: 'payday' };
}

function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const payday = p.payday === undefined ? true : Boolean(p.payday);
  let dom = null;
  if (typeof p.dom === 'number' && Number.isFinite(p.dom)) dom = Math.min(28, Math.max(1, Math.round(p.dom)));
  return { payday, dom };
}

async function readSubs() {
  const raw = await fs.readFile(SUB_FILE, 'utf8').catch(() => '');
  const byEndpoint = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.endpoint && r.keys) byEndpoint.set(r.endpoint, r);
    } catch {
      /* skip malformed */
    }
  }
  return [...byEndpoint.values()];
}

async function removeDead(deadEndpoints) {
  if (!deadEndpoints.size) return;
  const raw = await fs.readFile(SUB_FILE, 'utf8').catch(() => '');
  const kept = raw
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      try {
        return !deadEndpoints.has(JSON.parse(line).endpoint);
      } catch {
        return false;
      }
    });
  await fs.writeFile(SUB_FILE, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  console.log(`已清理失效订阅 ${deadEndpoints.size} 条`);
}

async function main() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const payday = getUpcomingPayday(now);

  const subs = await readSubs();
  if (!subs.length) {
    console.log('没有订阅，跳过。');
    return;
  }

  // 逐订阅判断今天是否是它的提醒日
  const message = buildMessage(payday, today);
  const targets = subs.filter((s) => {
    const prefs = normalizePrefs(s.prefs);
    if (!prefs.payday) return false;
    if (FORCE) return true;
    const R = reminderDateFor(prefs, payday);
    return sameDate(today, R);
  });

  if (!targets.length) {
    console.log(`本月发薪日 ${fmt(payday)}；今天没有任何订阅命中提醒日，跳过。`);
    return;
  }
  console.log(`本月发薪日 ${fmt(payday)}；命中 ${targets.length}/${subs.length} 条订阅${DRY ? ' (DRY)' : ''}`);
  if (DRY) return;

  const body = JSON.stringify(message);
  const dead = new Set();
  let ok = 0;
  await Promise.all(
    targets.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 6 * 60 * 60 });
        ok++;
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) dead.add(s.endpoint);
        else console.error(`发送失败 (${code || '?'}): ${String(err).slice(0, 120)}`);
      }
    })
  );
  console.log(`成功 ${ok} / ${targets.length}`);
  await removeDead(dead);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
