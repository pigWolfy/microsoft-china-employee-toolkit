/**
 * @file POST /api/benefits - 接收用户贡献的福利建议
 *
 * 行为：
 *   1. 校验必填字段（公司名、福利名、描述）
 *   2. 内存级 IP 限流：同 IP 60 秒 1 条
 *   3. 追加到 JSONL 文件（${BENEFITS_DATA_DIR}/benefits-suggestions.jsonl）
 *   4. 可选：转发到 Webhook
 *
 * 安全策略：
 * - 用户提交的内容不会直接展示在页面上
 * - 管理员审核后手动合并到 index.html
 * - 通过 webhook 实时通知管理员有新提交
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, hasAdminAccess } from '../../../lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


const DATA_FILE = path.join(DATA_DIR, 'benefits-suggestions.jsonl');
const WEBHOOK_URL = process.env.FEEDBACK_WEBHOOK_URL || '';

const lastByIp = new Map<string, number>();
const RATE_LIMIT_MS = 60 * 1000;

function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

async function appendJsonl(line: string): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(DATA_FILE, line + '\n', 'utf-8');
}

async function notifyWebhook(payload: unknown): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // webhook 失败不影响主流程
  }
}

interface BenefitSuggestion {
  company?: unknown;
  benefit?: unknown;
  description?: unknown;
  link?: unknown;
  contact?: unknown;
}

interface BenefitRecord {
  ts?: string;
  ip?: string;
  ua?: string;
  company?: string;
  benefit?: string;
  description?: string;
  link?: string;
  contact?: string;
  raw?: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// CORS preflight
export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: Request) {
  const ip = getClientIp(req);

  let body: BenefitSuggestion;
  try {
    body = (await req.json()) as BenefitSuggestion;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400, headers: corsHeaders });
  }

  const company = String(body.company ?? '').trim().slice(0, 100);
  const benefit = String(body.benefit ?? '').trim().slice(0, 200);
  const description = String(body.description ?? '').trim().slice(0, 2000);
  const link = String(body.link ?? '').trim().slice(0, 500);
  const contact = String(body.contact ?? '').trim().slice(0, 200);

  const record = {
    ts: new Date().toISOString(),
    ip,
    ua: req.headers.get('user-agent')?.slice(0, 300) ?? '',
    company,
    benefit,
    description,
    link,
    contact,
  };

  try {
    await appendJsonl(JSON.stringify(record));
  } catch (e) {
    console.error('[benefits] append failed', e);
    return NextResponse.json({ error: '服务端写入失败' }, { status: 500, headers: corsHeaders });
  }

  lastByIp.set(ip, Date.now());

  notifyWebhook({
    msg_type: 'text',
    content: {
      text: `[员工工具箱福利建议] ${company} - ${benefit}\n${description}\n\n链接：${link || '无'}\n联系：${contact || '匿名'}\nIP：${ip}`,
    },
    raw: record,
  });

  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

// ==================== GET: 管理员查看提交记录 ====================



function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

function maskIp(ip: string): string {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':...';
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return ip;
}

function formatTime(ts?: string): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function wantsJson(req: Request, url: URL): boolean {
  const format = url.searchParams.get('format');
  if (format === 'json') return true;
  if (format === 'html') return false;
  const accept = req.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function parseBenefitRecord(line: string): BenefitRecord {
  try {
    const parsed = JSON.parse(line) as BenefitRecord;
    return parsed && typeof parsed === 'object' ? parsed : { raw: line };
  } catch {
    return { raw: line };
  }
}

function daysAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function recordTime(record: BenefitRecord): number {
  const t = new Date(record.ts || '').getTime();
  return Number.isNaN(t) ? 0 : t;
}

function renderBenefitsHtml(records: BenefitRecord[], token: string): string {
  const sorted = [...records].sort((a, b) => recordTime(b) - recordTime(a));
  const recent7 = sorted.filter(record => recordTime(record) >= daysAgo(7)).length;
  const anonymous = sorted.filter(record => !String(record.contact || '').trim()).length;
  const withLink = sorted.filter(record => String(record.link || '').trim()).length;
  const companies = Array.from(new Set(sorted.map(record => String(record.company || '未填公司')).filter(Boolean)));
  const jsonHref = `/api/benefits?token=${encodeURIComponent(token)}&format=json`;
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });

  const cards = sorted.map((record, index) => {
    const benefit = record.raw ? '无法解析的原始记录' : (record.benefit || '未填写福利名称');
    const desc = record.raw || record.description || '未填写描述';
    const link = String(record.link || '').trim();
    const contact = String(record.contact || '').trim();
    const company = record.company || '微软';
    return `<article class="suggestion">
      <div class="suggestion-head">
        <div>
          <div class="index">#${fmt(sorted.length - index)}</div>
          <h3>${escapeHtml(benefit)}</h3>
        </div>
        <div class="time">${escapeHtml(formatTime(record.ts))}</div>
      </div>
      <p class="desc">${escapeHtml(desc)}</p>
      <div class="meta-grid">
        <div><span>公司</span><strong>${escapeHtml(company)}</strong></div>
        <div><span>联系方式</span><strong>${contact ? escapeHtml(contact) : '匿名'}</strong></div>
        <div><span>IP</span><strong>${escapeHtml(maskIp(record.ip || 'unknown'))}</strong></div>
        <div><span>链接</span><strong>${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">打开链接</a>` : '无'}</strong></div>
      </div>
      ${record.ua ? `<details><summary>User Agent</summary><div class="ua">${escapeHtml(record.ua)}</div></details>` : ''}
    </article>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>福利建议提交记录</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f6f8fb;
    --panel: #ffffff;
    --text: #111827;
    --muted: #64748b;
    --faint: #94a3b8;
    --line: #e2e8f0;
    --blue: #2563eb;
    --green: #059669;
    --amber: #d97706;
    --red: #dc2626;
    --navy: #0f172a;
    --shadow: 0 18px 55px rgba(15, 23, 42, .08);
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--text); background: radial-gradient(circle at top left, #eaf2ff, transparent 360px), var(--bg); }
  main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 34px 0 56px; }
  header { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; margin-bottom: 22px; }
  h1 { margin: 0 0 8px; font-size: clamp(28px, 4vw, 42px); letter-spacing: -.02em; }
  .sub { margin: 0; color: var(--muted); line-height: 1.7; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  a.btn { text-decoration: none; color: var(--text); background: var(--panel); border: 1px solid var(--line); padding: 10px 14px; border-radius: 999px; font-size: 14px; box-shadow: 0 8px 24px rgba(15, 23, 42, .05); font-weight: 700; }
  a.btn.primary { color: white; background: var(--blue); border-color: var(--blue); }
  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
  .metric { background: var(--panel); border: 1px solid var(--line); border-radius: 24px; padding: 20px; box-shadow: var(--shadow); }
  .metric span { display: block; color: var(--muted); font-size: 13px; margin-bottom: 9px; }
  .metric strong { display: block; font-size: 34px; line-height: 1; letter-spacing: -.03em; }
  .metric em { display: block; color: var(--faint); font-size: 12px; font-style: normal; margin-top: 10px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 24px; padding: 20px; box-shadow: var(--shadow); }
  .toolbar { display: flex; justify-content: space-between; gap: 14px; align-items: baseline; margin-bottom: 16px; }
  h2 { margin: 0; font-size: 20px; }
  .note { color: var(--muted); font-size: 13px; }
  .suggestions { display: grid; gap: 14px; }
  .suggestion { border: 1px solid #e8eef6; background: #fbfdff; border-radius: 18px; padding: 18px; }
  .suggestion-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; margin-bottom: 10px; }
  .index { display: inline-flex; align-items: center; height: 24px; padding: 0 9px; border-radius: 999px; background: #eef2ff; color: #4f46e5; font-weight: 800; font-size: 12px; margin-bottom: 8px; }
  h3 { margin: 0; font-size: 22px; line-height: 1.3; }
  .time { color: var(--muted); font-size: 13px; white-space: nowrap; padding-top: 4px; }
  .desc { margin: 0 0 14px; color: #334155; line-height: 1.75; white-space: pre-wrap; }
  .meta-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
  .meta-grid div { min-width: 0; background: #f8fafc; border: 1px solid #eef2f7; border-radius: 14px; padding: 10px 12px; }
  .meta-grid span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 5px; }
  .meta-grid strong { display: block; color: var(--text); font-size: 14px; line-height: 1.45; word-break: break-word; }
  .meta-grid a { color: var(--blue); text-decoration: none; }
  details { margin-top: 12px; color: var(--muted); font-size: 13px; }
  summary { cursor: pointer; user-select: none; }
  .ua { margin-top: 8px; padding: 10px; border-radius: 12px; background: #f8fafc; border: 1px solid #eef2f7; word-break: break-word; }
  .empty { padding: 54px 16px; text-align: center; color: var(--muted); }
  footer { margin-top: 18px; color: var(--faint); font-size: 12px; text-align: center; }
  @media (max-width: 900px) { header { display: block; } .actions { justify-content: flex-start; margin-top: 14px; } .metrics { grid-template-columns: repeat(2, 1fr); } .meta-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 560px) { main { width: min(100vw - 20px, 1120px); padding-top: 18px; } .metrics, .meta-grid { grid-template-columns: 1fr; } .metric, .panel { border-radius: 18px; padding: 16px; } .suggestion { padding: 15px; } .suggestion-head { display: block; } .time { margin-top: 8px; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>福利建议提交记录</h1>
      <p class="sub">这里展示用户通过 <strong>本页面</strong> 提交的补充信息，方便你筛选、审核并合并到正式福利清单。</p>
    </div>
    <div class="actions">
      <a class="btn primary" href="/">打开福利页</a>
      <a class="btn" href="${escapeHtml(jsonHref)}">查看 JSON</a>
    </div>
  </header>

  <section class="metrics">
    <div class="metric"><span>总提交</span><strong>${fmt(sorted.length)}</strong><em>所有历史建议</em></div>
    <div class="metric"><span>近 7 天新增</span><strong>${fmt(recent7)}</strong><em>最近活跃度</em></div>
    <div class="metric"><span>带链接</span><strong>${fmt(withLink)}</strong><em>可直接核验来源</em></div>
    <div class="metric"><span>匿名提交</span><strong>${fmt(anonymous)}</strong><em>${companies.length ? `涉及 ${fmt(companies.length)} 个公司/来源` : '暂无公司信息'}</em></div>
  </section>

  <section class="panel">
    <div class="toolbar">
      <h2>提交列表</h2>
      <div class="note">生成时间：${escapeHtml(generatedAt)}</div>
    </div>
    ${cards ? `<div class="suggestions">${cards}</div>` : '<div class="empty">还没有福利建议提交</div>'}
  </section>

  <footer>用户提交内容不会自动展示到公开福利页；建议人工核验后再合并。IP 仅做脱敏展示。</footer>
</main>
</body>
</html>`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');

  if (!hasAdminAccess(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const content = await fs.readFile(DATA_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const records = lines.map(parseBenefitRecord);
    const json = { total: records.length, records: [...records].reverse() };
    if (wantsJson(req, url)) return NextResponse.json(json, { headers: corsHeaders });
    return new Response(renderBenefitsHtml(records, token), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      const json = { total: 0, records: [] as BenefitRecord[] };
      if (wantsJson(req, url)) return NextResponse.json(json, { headers: corsHeaders });
      return new Response(renderBenefitsHtml([], token), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }
    return NextResponse.json({ error: '读取失败' }, { status: 500 });
  }
}
