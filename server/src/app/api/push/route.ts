/**
 * @file /api/push - Web Push 订阅管理（发薪日提醒）
 *
 * GET:  返回 VAPID 公钥，供前端 pushManager.subscribe 使用
 *       { publicKey: string }  —— 未配置密钥时返回空串，前端据此隐藏通知功能
 * POST: 保存一条 push 订阅（PushSubscription JSON）
 *       body: { subscription: {...}, page?: string }
 * DELETE: 按 endpoint 注销订阅
 *       body: { endpoint: string }
 *
 * 订阅存储在 ${BENEFITS_DATA_DIR}/push-subscriptions.jsonl（跨 release 持久化）。
 * 定时发送由 server/scripts/send-payday.mjs（cron）读取同一文件完成。
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


const DATA_FILE = path.join(DATA_DIR, 'push-subscriptions.jsonl');
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const lastByIp = new Map<string, number>();
const RATE_LIMIT_MS = 5 * 1000;

interface PushSubscriptionJSON {
  endpoint?: unknown;
  expirationTime?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

function isValidSubscription(sub: unknown): sub is Required<PushSubscriptionJSON> {
  if (!sub || typeof sub !== 'object') return false;
  const s = sub as PushSubscriptionJSON;
  if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint)) return false;
  if (s.endpoint.length > 2000) return false;
  if (!s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') return false;
  return true;
}

interface ReminderPrefs {
  payday: boolean;
  // 每月第几号提醒（1-28）；null = 默认「发薪日前一天」
  dom: number | null;
}

function normalizePrefs(raw: unknown): ReminderPrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as { payday?: unknown; dom?: unknown };
  const payday = p.payday === undefined ? true : Boolean(p.payday);
  let dom: number | null = null;
  if (typeof p.dom === 'number' && Number.isFinite(p.dom)) {
    dom = Math.min(28, Math.max(1, Math.round(p.dom)));
  }
  return { payday, dom };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  return NextResponse.json({ publicKey: VAPID_PUBLIC_KEY }, { headers: corsHeaders });
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const now = Date.now();
  const last = lastByIp.get(ip) ?? 0;
  if (now - last < RATE_LIMIT_MS) {
    return NextResponse.json({ error: '请求过于频繁，请稍后再试' }, { status: 429, headers: corsHeaders });
  }
  lastByIp.set(ip, now);

  let body: { subscription?: unknown; page?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400, headers: corsHeaders });
  }

  if (!isValidSubscription(body.subscription)) {
    return NextResponse.json({ error: 'invalid subscription' }, { status: 400, headers: corsHeaders });
  }

  const sub = body.subscription as Required<PushSubscriptionJSON>;
  const record = {
    ts: new Date().toISOString(),
    ip,
    ua: (req.headers.get('user-agent') || '').slice(0, 300),
    page: typeof body.page === 'string' ? body.page.slice(0, 120) : '/',
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    prefs: normalizePrefs((body as { prefs?: unknown }).prefs),
  };

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(DATA_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('[push] append failed', err);
    return NextResponse.json({ error: 'storage error' }, { status: 500, headers: corsHeaders });
  }

  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

export async function DELETE(req: Request) {
  let body: { endpoint?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400, headers: corsHeaders });
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) {
    return NextResponse.json({ error: 'endpoint required' }, { status: 400, headers: corsHeaders });
  }

  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8').catch(() => '');
    const kept = raw
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        try {
          return (JSON.parse(line) as { endpoint?: string }).endpoint !== endpoint;
        } catch {
          return false;
        }
      });
    await fs.writeFile(DATA_FILE, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  } catch (err) {
    console.error('[push] delete failed', err);
    return NextResponse.json({ error: 'storage error' }, { status: 500, headers: corsHeaders });
  }

  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}
