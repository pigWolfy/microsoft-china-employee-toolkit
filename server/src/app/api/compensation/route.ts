/**
 * @file /api/compensation - Anonymous Microsoft salary midpoint submissions
 *
 * POST: accept level/site/base/compa-ratio samples from the standalone benefits page.
 * GET: return aggregated midpoint stats only. Raw records require ADMIN_TOKEN + raw=1.
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, hasAdminAccess } from '../../../lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


const DATA_FILE = path.join(DATA_DIR, 'ms-compensation.jsonl');

const DEFAULT_ANNUAL_ADJUSTMENT = 1.05;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const lastByIp = new Map<string, number>();
const RATE_LIMIT_MS = 30 * 1000;

interface CompensationBody {
  level?: unknown;
  site?: unknown;
  baseWan?: unknown;
  compaRatio?: unknown;
  cycleYear?: unknown;
  note?: unknown;
}

interface CompensationRecord {
  ts: string;
  ip: string;
  ua: string;
  level: number;
  site: string;
  baseWan: number;
  compaRatio: number;
  midpointWan: number;
  cycleYear?: number | null;
  note: string;
}

interface CompensationGroup {
  key: string;
  level: number;
  site: string;
  count: number;
  targetCycleYear: number;
  currentCount: number;
  historicalCount: number;
  unknownCount: number;
  effectiveSampleWeight: number;
  estimatedMidpointWan: number | null;
  p25EstimatedWan: number | null;
  p75EstimatedWan: number | null;
  medianMidpointWan: number | null;
  p25MidpointWan: number | null;
  p75MidpointWan: number | null;
  minMidpointWan: number | null;
  maxMidpointWan: number | null;
  confidence: '高' | '中' | '低';
  lastSubmittedAt: string;
  lowSample: boolean;
}

interface WeightedValue {
  value: number;
  weight: number;
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  return Number(String(value ?? '').trim());
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function getDefaultCycleYear(date = new Date()): number {
  return date.getMonth() >= 8 ? date.getFullYear() : date.getFullYear() - 1;
}

function normalizeCycleYear(value: unknown): number | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'unknown' || text === 'uncertain' || text === '不确定') return null;
  const year = Math.trunc(Number(text));
  const current = new Date().getFullYear();
  if (!Number.isFinite(year) || year < 2018 || year > current + 1) return null;
  return year;
}

function normalizeSite(value: unknown): string {
  const raw = String(value ?? '').trim();
  const normalized = raw
    .replace(/微软/g, '')
    .replace(/市$/g, '')
    .replace(/\s+/g, '');
  if (!normalized) return '未填写';
  const aliases: Record<string, string> = {
    BJ: '北京',
    Beijing: '北京',
    北京: '北京',
    苏州: '苏州',
    Suzhou: '苏州',
    SZ: '苏州',
    上海: '上海',
    Shanghai: '上海',
    SH: '上海',
    远程: '远程/其他',
    其他: '远程/其他',
  };
  return aliases[normalized] || raw.slice(0, 40);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function weightedPercentile(values: WeightedValue[], p: number): number | null {
  const sorted = values.filter(item => item.weight > 0).sort((a, b) => a.value - b.value);
  if (!sorted.length) return null;
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  const threshold = totalWeight * p;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= threshold) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

function adjustmentFactor(cycleYear: number, targetCycleYear: number): number {
  const age = targetCycleYear - cycleYear;
  if (age <= 0) return 1;
  return Math.pow(DEFAULT_ANNUAL_ADJUSTMENT, age);
}

function historicalWeight(cycleYear: number, targetCycleYear: number): number {
  const age = targetCycleYear - cycleYear;
  if (age <= 0) return 1;
  return Math.pow(0.6, age);
}

function confidence(currentCount: number, historicalCount: number): '高' | '中' | '低' {
  if (currentCount >= 5) return '高';
  if (currentCount >= 2 || currentCount + historicalCount >= 5) return '中';
  return '低';
}

function parseRecord(line: string): CompensationRecord | null {
  try {
    const parsed = JSON.parse(line) as CompensationBody & Partial<CompensationRecord>;
    if (!parsed || typeof parsed !== 'object') return null;

    const level = Math.trunc(asNumber(parsed.level));
    const midpointWan = asNumber(parsed.midpointWan);
    if (!Number.isFinite(level) || level <= 0) return null;
    if (!Number.isFinite(midpointWan) || midpointWan <= 0) return null;

    const baseWan = asNumber(parsed.baseWan);
    const compaRatio = asNumber(parsed.compaRatio);
    return {
      ts: typeof parsed.ts === 'string' ? parsed.ts : new Date(0).toISOString(),
      ip: typeof parsed.ip === 'string' ? parsed.ip : 'unknown',
      ua: typeof parsed.ua === 'string' ? parsed.ua : '',
      level,
      site: normalizeSite(parsed.site),
      baseWan: Number.isFinite(baseWan) ? round1(baseWan) : round1(midpointWan),
      compaRatio: Number.isFinite(compaRatio) && compaRatio > 0 ? Math.round(compaRatio * 1000) / 1000 : 0,
      midpointWan: round1(midpointWan),
      cycleYear: normalizeCycleYear(parsed.cycleYear),
      note: String(parsed.note ?? '').slice(0, 300),
    };
  } catch {
    return null;
  }
}

async function readRecords(): Promise<CompensationRecord[]> {
  try {
    const content = await fs.readFile(DATA_FILE, 'utf-8');
    return content.split('\n').filter(Boolean).map(parseRecord).filter((record): record is CompensationRecord => Boolean(record));
  } catch {
    return [];
  }
}

function aggregate(records: CompensationRecord[], targetCycleYear = getDefaultCycleYear()): CompensationGroup[] {
  const map = new Map<string, CompensationRecord[]>();
  for (const record of records) {
    const key = `${record.site}|${record.level}`;
    const list = map.get(key) || [];
    list.push(record);
    map.set(key, list);
  }

  return Array.from(map.entries()).map(([key, list]) => {
    const weightedValues: WeightedValue[] = [];
    let currentCount = 0;
    let historicalCount = 0;
    let unknownCount = 0;

    for (const record of list) {
      const cycleYear = normalizeCycleYear(record.cycleYear);
      if (!cycleYear) {
        unknownCount++;
        continue;
      }
      if (cycleYear > targetCycleYear) continue;
      const age = targetCycleYear - cycleYear;
      if (age > 3) continue;
      if (age === 0) currentCount++;
      else historicalCount++;
      weightedValues.push({
        value: record.midpointWan * adjustmentFactor(cycleYear, targetCycleYear),
        weight: historicalWeight(cycleYear, targetCycleYear),
      });
    }

    const sorted = weightedValues.map(item => item.value).sort((a, b) => a - b);
    const estimated = weightedPercentile(weightedValues, 0.5);
    const p25 = weightedPercentile(weightedValues, 0.25);
    const p75 = weightedPercentile(weightedValues, 0.75);
    const groupConfidence = confidence(currentCount, historicalCount);
    const latest = list.reduce((max, record) => record.ts > max ? record.ts : max, '');
    return {
      key,
      site: list[0].site,
      level: list[0].level,
      count: list.length,
      targetCycleYear,
      currentCount,
      historicalCount,
      unknownCount,
      effectiveSampleWeight: round1(weightedValues.reduce((sum, item) => sum + item.weight, 0)),
      estimatedMidpointWan: estimated === null ? null : round1(estimated),
      p25EstimatedWan: p25 === null ? null : round1(p25),
      p75EstimatedWan: p75 === null ? null : round1(p75),
      medianMidpointWan: estimated === null ? null : round1(estimated),
      p25MidpointWan: p25 === null ? null : round1(p25),
      p75MidpointWan: p75 === null ? null : round1(p75),
      minMidpointWan: sorted.length ? round1(sorted[0]) : null,
      maxMidpointWan: sorted.length ? round1(sorted[sorted.length - 1]) : null,
      confidence: groupConfidence,
      lastSubmittedAt: latest,
      lowSample: groupConfidence !== '高',
    } satisfies CompensationGroup;
  }).sort((a, b) => a.level - b.level || String(a.site).localeCompare(String(b.site), 'zh-CN'));
}

export async function POST(req: Request) {
  const ip = getClientIp(req);
  const now = Date.now();
  const last = lastByIp.get(ip) || 0;
  if (now - last < RATE_LIMIT_MS) {
    const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
    return NextResponse.json({ error: `提交太频繁，请 ${wait} 秒后再试` }, { status: 429, headers: corsHeaders });
  }

  let body: CompensationBody;
  try {
    body = await req.json() as CompensationBody;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400, headers: corsHeaders });
  }

  const level = Math.trunc(asNumber(body.level));
  const baseWan = asNumber(body.baseWan);
  const compaRatio = asNumber(body.compaRatio);
  const cycleYear = normalizeCycleYear(body.cycleYear);
  const site = normalizeSite(body.site);
  const note = String(body.note ?? '').trim().slice(0, 300);

  if (level < 50 || level > 80) {
    return NextResponse.json({ error: 'Level 范围应在 50-80 之间' }, { status: 400, headers: corsHeaders });
  }
  if (!Number.isFinite(baseWan) || baseWan < 5 || baseWan > 500) {
    return NextResponse.json({ error: '年 Base 请填写“万元”数值，例如 40' }, { status: 400, headers: corsHeaders });
  }
  if (!Number.isFinite(compaRatio) || compaRatio < 0.3 || compaRatio > 2) {
    return NextResponse.json({ error: 'Compa ratio 请填写 0.3-2 之间的小数，例如 0.9' }, { status: 400, headers: corsHeaders });
  }

  const record: CompensationRecord = {
    ts: new Date().toISOString(),
    ip,
    ua: req.headers.get('user-agent')?.slice(0, 300) ?? '',
    level,
    site,
    baseWan: round1(baseWan),
    compaRatio: Math.round(compaRatio * 1000) / 1000,
    midpointWan: round1(baseWan / compaRatio),
    cycleYear,
    note,
  };

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(DATA_FILE, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    return NextResponse.json({ error: '服务端写入失败' }, { status: 500, headers: corsHeaders });
  }

  lastByIp.set(ip, now);
  const groups = aggregate(await readRecords());
  return NextResponse.json({ ok: true, submitted: { level, site, cycleYear, midpointWan: record.midpointWan }, targetCycleYear: getDefaultCycleYear(), annualAdjustment: DEFAULT_ANNUAL_ADJUSTMENT, groups }, { headers: corsHeaders });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get('raw') === '1';
  const token = url.searchParams.get('token');
  const targetCycleYear = normalizeCycleYear(url.searchParams.get('targetCycleYear')) || getDefaultCycleYear();
  const records = await readRecords();
  const groups = aggregate(records, targetCycleYear);

  if (raw) {
    if (!hasAdminAccess(token)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    return NextResponse.json({ total: records.length, records: [...records].reverse(), targetCycleYear, annualAdjustment: DEFAULT_ANNUAL_ADJUSTMENT, groups }, { headers: corsHeaders });
  }

  return NextResponse.json({ total: records.length, targetCycleYear, annualAdjustment: DEFAULT_ANNUAL_ADJUSTMENT, groups, updatedAt: new Date().toISOString() }, { headers: corsHeaders });
}