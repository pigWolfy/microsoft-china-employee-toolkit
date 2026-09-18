/**
 * @file /api/stats - 页面访问统计
 *
 * POST: 记录一次页面访问（page view）
 * GET:  查看统计数据（需 token）
 *
 * 数据存储在 ${BENEFITS_DATA_DIR}/pageviews.jsonl
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, hasAdminAccess } from '../../../lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


const DATA_FILE = path.join(DATA_DIR, 'pageviews.jsonl');
const GEO_CACHE_FILE = path.join(DATA_DIR, 'ip-geo-cache.json');
const SUBS_FILE = path.join(DATA_DIR, 'push-subscriptions.jsonl');
const PWA_EVENTS_FILE = path.join(DATA_DIR, 'pwa-events.jsonl');


// Tab 访问统计：福利页各 tab 以 /benefits/ms/tab/<name> 形式上报，单独归类不计入页面 PV
const TAB_PAGE_PREFIX = '/benefits/ms/tab/';
const TAB_LABELS: Record<string, string> = {
  benefits: '💼 福利项',
  payday: '💰 薪资·假期',
  calc: '🎁 接裁神',
  chat: '💬 匿名群聊',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

interface PageviewRecord {
  ts?: string;
  page?: string;
  ip?: string;
  ua?: string;
  ref?: string;
}

interface StatsSummary {
  total: number;
  today: number;
  todayUV: number;
  pages: Record<string, number>;
  daily: Record<string, { pv: number; uv: number }>;
}

interface StatsMeta {
  totalUV: number;
  days: number;
  last7PV: number;
  last7UV: number;
  prev7PV: number;
  avgPV: number;
  peakDay?: { day: string; pv: number; uv: number };
}

interface GeoInfo {
  country: string;
  region: string;
  city: string;
  label: string;
  updatedAt: string;
}

type GeoCache = Record<string, GeoInfo>;

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

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function maskIp(ip: string): string {
  if (!ip || ip === 'unknown') return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':...';
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.*`;
  return ip;
}

function fmt(n: number): string {
  return new Intl.NumberFormat('zh-CN').format(n);
}

function dateLabel(day: string): string {
  const [, month, date] = day.split('-');
  return `${month}-${date}`;
}

function percentChange(now: number, prev: number): { label: string; cls: string } {
  if (!prev && now > 0) return { label: '新增长', cls: 'up' };
  if (!prev) return { label: '无变化', cls: 'flat' };
  const diff = ((now - prev) / prev) * 100;
  if (Math.abs(diff) < 1) return { label: '基本持平', cls: 'flat' };
  return { label: `${diff > 0 ? '↑' : '↓'} ${Math.abs(diff).toFixed(0)}%`, cls: diff > 0 ? 'up' : 'down' };
}

interface UaBreakdownItem {
  label: string;
  count: number;
  percent: number;
}

interface TabStatItem extends UaBreakdownItem {
  uv: number;
}

interface UaBreakdown {
  os: UaBreakdownItem[];
  device: UaBreakdownItem[];
  browser: UaBreakdownItem[];
  total: number;
}

function classifyUa(ua: string): { os: string; device: string; browser: string } {
  const value = ua || '';
  const lower = value.toLowerCase();

  let os = '其他';
  if (/iphone|ipad|ipod|cpu iphone os/i.test(value)) os = 'iOS';
  else if (/android/i.test(value)) os = 'Android';
  else if (/windows/i.test(value)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(value) && !/iphone|ipad/i.test(value)) os = 'macOS';
  else if (/cros|chromium os/i.test(value)) os = 'ChromeOS';
  else if (/linux/i.test(value)) os = 'Linux';
  else if (!value) os = '未提供';

  let browser = '其他';
  if (/micromessenger/i.test(value)) browser = '微信内置';
  else if (/maimai/i.test(value)) browser = '脉脉 App';
  else if (/edg\//i.test(value)) browser = 'Edge';
  else if (/firefox/i.test(value)) browser = 'Firefox';
  else if (/opr\//i.test(value)) browser = 'Opera';
  else if (/chrome\//i.test(lower) && !/edg\//i.test(lower)) browser = 'Chrome';
  else if (/safari/i.test(value) && !/chrome|edg\//i.test(lower)) browser = 'Safari';
  else if (!value) browser = '未提供';

  let device = '桌面';
  if (/micromessenger/i.test(value)) device = '微信浏览器';
  else if (/maimai/i.test(value)) device = '脉脉 App';
  else if (/ipad|tablet/i.test(value)) device = '平板';
  else if (/iphone|ipod|android.*mobile|mobile/i.test(value)) device = '移动端';
  else if (/android/i.test(value)) device = '移动端';
  else if (!value) device = '未提供';

  return { os, device, browser };
}

function summarizeUa(records: PageviewRecord[]): UaBreakdown {
  const osMap = new Map<string, number>();
  const deviceMap = new Map<string, number>();
  const browserMap = new Map<string, number>();
  let total = 0;

  for (const record of records) {
    const { os, device, browser } = classifyUa(String(record.ua ?? ''));
    total++;
    osMap.set(os, (osMap.get(os) || 0) + 1);
    deviceMap.set(device, (deviceMap.get(device) || 0) + 1);
    browserMap.set(browser, (browserMap.get(browser) || 0) + 1);
  }

  const toList = (map: Map<string, number>): UaBreakdownItem[] => {
    const items = Array.from(map.entries()).map(([label, count]) => ({
      label,
      count,
      percent: total ? Math.round((count / total) * 1000) / 10 : 0,
    }));
    items.sort((a, b) => b.count - a.count);
    return items;
  };

  return { os: toList(osMap), device: toList(deviceMap), browser: toList(browserMap), total };
}

function isPublicIp(ip: string): boolean {
  if (!ip || ip === 'unknown') return false;
  if (ip === '127.0.0.1' || ip === '::1') return false;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return false;
  if (/^169\.254\./.test(ip)) return false;
  const lower = ip.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return false;
  return true;
}

function normalizeCountry(country: string): string {
  const value = country.trim();
  if (!value) return '';
  if (['中国', '中华人民共和国', '中華人民共和國', 'China'].includes(value)) return '中国';
  return value;
}

function normalizeChinaPlace(value: string): string {
  return value
    .trim()
    .replace(/^中国/, '')
    .replace(/^中華人民共和國/, '')
    .replace(/^中华人民共和国/, '')
    .replace(/市辖区$/, '')
    .replace(/特别行政区$/, '')
    .replace(/壮族自治区$/, '')
    .replace(/回族自治区$/, '')
    .replace(/维吾尔自治区$/, '')
    .replace(/自治区$/, '')
    .replace(/省$/, '')
    .replace(/市$/, '');
}

function buildGeoLabel(country: string, region: string, city: string): string {
  const normalizedCountry = normalizeCountry(country);

  if (normalizedCountry === '中国') {
    const normalizedRegion = normalizeChinaPlace(region);
    const normalizedCity = normalizeChinaPlace(city);
    const municipalities = new Set(['北京', '上海', '天津', '重庆']);
    const municipality = [normalizedRegion, normalizedCity].find(value => municipalities.has(value));

    if (municipality) return `中国 · ${municipality}`;
    if (normalizedRegion && normalizedCity && normalizedRegion !== normalizedCity) {
      return `中国 · ${normalizedRegion} · ${normalizedCity}`;
    }
    if (normalizedCity) return `中国 · ${normalizedCity}`;
    if (normalizedRegion) return `中国 · ${normalizedRegion}`;
    return '中国';
  }

  const parts = [normalizedCountry, region.trim(), city.trim()].filter(Boolean);
  if (!parts.length) return '未知地区';
  return Array.from(new Set(parts)).join(' · ');
}

function normalizeCachedGeoLabel(info: GeoInfo): string {
  if (info.country || info.region || info.city) {
    return buildGeoLabel(info.country, info.region, info.city);
  }

  const parts = String(info.label || '').split(' · ');
  if (parts.length >= 2) return buildGeoLabel(parts[0] || '', parts[1] || '', parts[2] || '');
  return info.label || '未知地区';
}

async function readGeoCache(): Promise<GeoCache> {
  try {
    return JSON.parse(await fs.readFile(GEO_CACHE_FILE, 'utf-8')) as GeoCache;
  } catch {
    return {};
  }
}

async function writeGeoCache(cache: GeoCache): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(GEO_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // 地理缓存失败不影响统计页展示
  }
}

async function resolveGeo(records: PageviewRecord[]): Promise<GeoCache> {
  const cache = await readGeoCache();
  const uniqueIps = Array.from(new Set([...records].reverse().map(record => String(record.ip || 'unknown'))));
  const missing = uniqueIps.filter(ip => isPublicIp(ip) && !cache[ip]);

  if (!missing.length) return cache;

  let changed = false;
  const chunks: string[][] = [];
  for (let i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100));

  for (const chunk of chunks.slice(0, 2)) {
    try {
      const res = await fetch('http://ip-api.com/batch?fields=status,country,regionName,city,query,message&lang=zh-CN', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = await res.json() as Array<{ status?: string; country?: string; regionName?: string; city?: string; query?: string }>;
      for (const item of data) {
        const ip = String(item.query || '');
        if (!ip || item.status !== 'success') continue;
        const country = String(item.country || '').trim();
        const region = String(item.regionName || '').trim();
        const city = String(item.city || '').trim();
        cache[ip] = {
          country,
          region,
          city,
          label: buildGeoLabel(country, region, city),
          updatedAt: new Date().toISOString(),
        };
        changed = true;
      }
    } catch {
      // 外部 IP 解析服务失败时保留未知状态，下次访问再试
    }
  }

  if (changed) await writeGeoCache(cache);
  return cache;
}

function geoLabel(ip: string, cache: GeoCache): string {
  if (!isPublicIp(ip)) return '内网 / 未知';
  return cache[ip] ? normalizeCachedGeoLabel(cache[ip]) : '待解析';
}

function isUnknownGeo(label: string): boolean {
  return label === '待解析' || label === '内网 / 未知' || label === '未知地区';
}

function buildStats(records: PageviewRecord[]): { summary: StatsSummary; meta: StatsMeta } {
  const daily: Record<string, { pv: number; uv: Set<string> }> = {};
  const pages: Record<string, number> = {};
  const allIps = new Set<string>();
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const record of records) {
    const ts = String(record.ts ?? '');
    const day = ts.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;

    const ip = String(record.ip || 'unknown');
    if (!daily[day]) daily[day] = { pv: 0, uv: new Set() };
    daily[day].pv++;
    daily[day].uv.add(ip);
    allIps.add(ip);

    const page = String(record.page || '/');
    pages[page] = (pages[page] || 0) + 1;
  }

  const dailyOut: Record<string, { pv: number; uv: number }> = {};
  for (const [day, data] of Object.entries(daily)) {
    dailyOut[day] = { pv: data.pv, uv: data.uv.size };
  }

  const entries = Object.entries(dailyOut).sort(([a], [b]) => a.localeCompare(b));
  const last7 = entries.slice(-7);
  const prev7 = entries.slice(-14, -7);
  const last7PV = last7.reduce((sum, [, value]) => sum + value.pv, 0);
  const last7UV = last7.reduce((sum, [, value]) => sum + value.uv, 0);
  const prev7PV = prev7.reduce((sum, [, value]) => sum + value.pv, 0);
  const peak = entries.reduce<{ day: string; pv: number; uv: number } | undefined>((best, [day, value]) => {
    if (!best || value.pv > best.pv) return { day, pv: value.pv, uv: value.uv };
    return best;
  }, undefined);

  return {
    summary: {
      total: records.length,
      today: daily[todayStr]?.pv ?? 0,
      todayUV: daily[todayStr]?.uv.size ?? 0,
      pages,
      daily: dailyOut,
    },
    meta: {
      totalUV: allIps.size,
      days: entries.length,
      last7PV,
      last7UV,
      prev7PV,
      avgPV: entries.length ? Math.round(records.length / entries.length) : 0,
      peakDay: peak,
    },
  };
}

function emptyStats(): { summary: StatsSummary; meta: StatsMeta } {
  return buildStats([]);
}

// 统计各 tab 访问次数（PV）、去重访客（UV）与占比
function summarizeTabs(tabRecords: PageviewRecord[]): { items: TabStatItem[]; total: number; totalUV: number } {
  const map = new Map<string, { count: number; uv: Set<string> }>();
  const allUV = new Set<string>();
  for (const record of tabRecords) {
    const page = String(record.page || '');
    if (!page.startsWith(TAB_PAGE_PREFIX)) continue;
    const name = page.slice(TAB_PAGE_PREFIX.length).split(/[/?#]/)[0] || '未知';
    const ip = String(record.ip || 'unknown');
    if (!map.has(name)) map.set(name, { count: 0, uv: new Set() });
    const entry = map.get(name)!;
    entry.count++;
    entry.uv.add(ip);
    allUV.add(ip);
  }
  const total = Array.from(map.values()).reduce((sum, v) => sum + v.count, 0);
  const items: TabStatItem[] = Array.from(map.entries())
    .map(([name, v]) => ({
      label: TAB_LABELS[name] || name,
      count: v.count,
      uv: v.uv.size,
      percent: total ? Math.round((v.count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);
  return { items, total, totalUV: allUV.size };
}

function wantsJson(req: Request, url: URL): boolean {
  const format = url.searchParams.get('format');
  if (format === 'json') return true;
  if (format === 'html') return false;
  const accept = req.headers.get('accept') || '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

interface EngagementStats {
  installUniqueDevices: number; // 以 PWA 方式打开的去重设备数（近似“存到桌面”的活跃设备）
  installEvents: number;        // appinstalled 触发次数（iOS 不上报）
  standaloneOpens: number;      // PWA 打开总次数
  subsTotal: number;            // 去重 endpoint 后订阅总数
  subsEnabled: number;          // 其中开启发薪日提醒的
  subsCustom: number;           // 其中自定义提醒日期的
  subsPeople: number;           // 按 IP+UA 去重的“疑似真人”数
  subsActive30d: number;        // 最近 30 天有过记录的订阅（活跃）
}

async function readEngagement(): Promise<EngagementStats> {
  // 订阅统计（按 endpoint 去重，最后一条为准）
  let subsTotal = 0, subsEnabled = 0, subsCustom = 0, subsActive30d = 0;
  const people = new Set<string>();
  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  try {
    const raw = await fs.readFile(SUBS_FILE, 'utf-8');
    const byEndpoint = new Map<string, { payday: boolean; dom: number | null; ipua: string; ts: number }>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { endpoint?: string; prefs?: { payday?: boolean; dom?: number | null }; ip?: string; ua?: string; ts?: string };
        if (!r.endpoint) continue;
        const payday = r.prefs?.payday === undefined ? true : Boolean(r.prefs.payday);
        const dom = typeof r.prefs?.dom === 'number' ? r.prefs.dom : null;
        const ipua = `${r.ip || ''}|${r.ua || ''}`;
        const ts = r.ts ? Date.parse(r.ts) : 0;
        byEndpoint.set(r.endpoint, { payday, dom, ipua, ts });
      } catch { /* skip */ }
    }
    subsTotal = byEndpoint.size;
    for (const v of byEndpoint.values()) {
      if (v.payday) {
        subsEnabled++;
        if (v.ipua !== '|') people.add(v.ipua);
      }
      if (v.dom != null) subsCustom++;
      if (v.ts && now - v.ts < THIRTY_DAYS) subsActive30d++;
    }
  } catch { /* no subs yet */ }

  // PWA 事件统计
  let installEvents = 0, standaloneOpens = 0;
  const devices = new Set<string>();
  try {
    const raw = await fs.readFile(PWA_EVENTS_FILE, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { event?: string; id?: string };
        if (r.event === 'pwa_install') installEvents++;
        if (r.event === 'pwa_open') { standaloneOpens++; if (r.id) devices.add(r.id); }
      } catch { /* skip */ }
    }
  } catch { /* no events yet */ }

  return { installUniqueDevices: devices.size, installEvents, standaloneOpens, subsTotal, subsEnabled, subsCustom, subsPeople: people.size, subsActive30d };
}

function renderStatsHtml(summary: StatsSummary, meta: StatsMeta, records: PageviewRecord[], token: string, geoCache: GeoCache, engagement: EngagementStats, tabStats: { items: TabStatItem[]; total: number; totalUV: number }): string {
  const entries = Object.entries(summary.daily).sort(([a], [b]) => a.localeCompare(b));
  const chartEntries = entries.slice(-30);
  const maxPV = Math.max(1, ...chartEntries.map(([, value]) => value.pv));
  const pageRows = Object.entries(summary.pages).sort(([, a], [, b]) => b - a);
  const latest = records.slice(-20).reverse();
  const trend = percentChange(meta.last7PV, meta.prev7PV);
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const jsonHref = `/api/stats?token=${encodeURIComponent(token)}&format=json`;
  const cityMap = new Map<string, { pv: number; uv: Set<string> }>();

  for (const record of records) {
    const ip = String(record.ip || 'unknown');
    const label = geoLabel(ip, geoCache);
    const current = cityMap.get(label) || { pv: 0, uv: new Set<string>() };
    current.pv++;
    current.uv.add(ip);
    cityMap.set(label, current);
  }

  const cityRows = Array.from(cityMap.entries())
    .map(([label, value]) => ({ label, pv: value.pv, uv: value.uv.size }))
    .sort((a, b) => Number(isUnknownGeo(a.label)) - Number(isUnknownGeo(b.label)) || b.pv - a.pv)
    .slice(0, 12);

  const bars = chartEntries.map(([day, value]) => {
    const h = Math.max(8, Math.round((value.pv / maxPV) * 156));
    return `
      <div class="bar-item" title="${escapeHtml(day)}：${fmt(value.pv)} PV / ${fmt(value.uv)} UV">
        <div class="bar-value">${fmt(value.pv)}</div>
        <div class="bar-track"><div class="bar" style="height:${h}px"></div></div>
        <div class="bar-date">${escapeHtml(dateLabel(day))}</div>
      </div>`;
  }).join('');

  const dayRows = entries.slice().reverse().map(([day, value]) => {
    const rate = value.pv ? Math.round((value.uv / value.pv) * 100) : 0;
    return `<tr><td>${escapeHtml(day)}</td><td>${fmt(value.pv)}</td><td>${fmt(value.uv)}</td><td>${rate}%</td></tr>`;
  }).join('');

  const pages = pageRows.map(([page, count]) => {
    const pct = summary.total ? Math.round((count / summary.total) * 100) : 0;
    return `<tr><td><code>${escapeHtml(page)}</code></td><td>${fmt(count)}</td><td><div class="mini-meter"><span style="width:${pct}%"></span></div></td><td>${pct}%</td></tr>`;
  }).join('');

  const cities = cityRows.map(row => {
    const pct = summary.total ? Math.round((row.pv / summary.total) * 100) : 0;
    return `<tr><td>${escapeHtml(row.label)}</td><td>${fmt(row.pv)}</td><td>${fmt(row.uv)}</td><td><div class="mini-meter"><span style="width:${pct}%"></span></div></td><td>${pct}%</td></tr>`;
  }).join('');

  const recent = latest.map(record => {
    const ts = record.ts ? new Date(record.ts).toLocaleString('zh-CN', { hour12: false }) : '-';
    const ip = String(record.ip || 'unknown');
    return `<tr><td>${escapeHtml(ts)}</td><td><code>${escapeHtml(record.page || '/')}</code></td><td>${escapeHtml(geoLabel(ip, geoCache))}</td><td>${escapeHtml(maskIp(ip))}</td><td class="ua">${escapeHtml(record.ua || '-')}</td></tr>`;
  }).join('');

  const uaBreakdown = summarizeUa(records);
  const donutPalette = ['#2563eb', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#0ea5e9', '#dc2626', '#14b8a6', '#6366f1', '#64748b'];
  const renderDonut = (title: string, items: UaBreakdownItem[]) => {
    if (!items.length) {
      return `<div class="donut-card"><h3>${escapeHtml(title)}</h3><div class="empty">暂无数据</div></div>`;
    }
    const top = items.slice(0, 6);
    const restCount = items.slice(6).reduce((sum, item) => sum + item.count, 0);
    const restPercent = items.slice(6).reduce((sum, item) => sum + item.percent, 0);
    const slices: UaBreakdownItem[] = top.map(item => ({ ...item }));
    if (restCount > 0) {
      const existing = slices.find(item => item.label === '其他');
      if (existing) {
        existing.count += restCount;
        existing.percent = Math.round((existing.percent + restPercent) * 10) / 10;
      } else {
        slices.push({ label: '其他', count: restCount, percent: Math.round(restPercent * 10) / 10 });
      }
    }
    slices.sort((a, b) => b.count - a.count);
    let cursor = 0;
    const gradientStops = slices.map((item, index) => {
      const start = cursor;
      cursor += item.percent;
      const end = index === slices.length - 1 ? 100 : Math.min(cursor, 100);
      return `${donutPalette[index % donutPalette.length]} ${start}% ${end}%`;
    }).join(', ');
    const legend = slices.map((item, index) => `<li><span class="swatch" style="background:${donutPalette[index % donutPalette.length]}"></span><span class="legend-label">${escapeHtml(item.label)}</span><span class="legend-meta">${fmt(item.count)} · ${item.percent}%</span></li>`).join('');
    const top1 = slices[0];
    return `<div class="donut-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="donut-row">
        <div class="donut" style="background: conic-gradient(${gradientStops})">
          <div class="donut-hole">
            <span class="donut-top-label">${escapeHtml(top1.label)}</span>
            <span class="donut-top-value">${top1.percent}%</span>
          </div>
        </div>
        <ul class="donut-legend">${legend}</ul>
      </div>
    </div>`;
  };
  const uaSection = uaBreakdown.total
    ? `<div class="donut-grid">${renderDonut('操作系统', uaBreakdown.os)}${renderDonut('设备类型', uaBreakdown.device)}${renderDonut('浏览器', uaBreakdown.browser)}</div>`
    : '<div class="empty">暂无 User Agent 数据</div>';

  const tabTableRows = tabStats.items.map(item =>
    `<tr><td>${escapeHtml(item.label)}</td><td>${fmt(item.count)}</td><td>${fmt(item.uv)}</td><td><div class="mini-meter"><span style="width:${item.percent}%"></span></div></td><td>${item.percent}%</td></tr>`
  ).join('');
  const tabSection = tabStats.total
    ? `<div class="donut-grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.2fr)">
        ${renderDonut('Tab 访问占比', tabStats.items)}
        <div class="donut-card"><h3>各 Tab 明细（共 ${fmt(tabStats.total)} 次切换 · ${fmt(tabStats.totalUV)} 独立访客）</h3>
          <table><thead><tr><th>Tab</th><th>次数 PV</th><th>访客 UV</th><th>占比</th><th></th></tr></thead><tbody>${tabTableRows}</tbody></table>
        </div>
      </div>`
    : '<div class="empty">暂无 Tab 访问数据</div>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>福利页访问统计</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f5f7fb;
    --panel: #ffffff;
    --text: #111827;
    --muted: #64748b;
    --line: #e2e8f0;
    --blue: #2563eb;
    --green: #059669;
    --amber: #d97706;
    --red: #dc2626;
    --shadow: 0 18px 55px rgba(15, 23, 42, .08);
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; background: radial-gradient(circle at top left, #eaf2ff, transparent 360px), var(--bg); color: var(--text); }
  main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 34px 0 56px; }
  header { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; margin-bottom: 22px; }
  h1 { margin: 0 0 8px; font-size: clamp(28px, 4vw, 42px); letter-spacing: -.02em; }
  .sub { margin: 0; color: var(--muted); line-height: 1.7; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
  a.btn { text-decoration: none; color: var(--text); background: var(--panel); border: 1px solid var(--line); padding: 10px 14px; border-radius: 999px; font-size: 14px; box-shadow: 0 8px 24px rgba(15, 23, 42, .05); }
  a.btn.primary { color: white; background: var(--blue); border-color: var(--blue); }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 24px; padding: 20px; box-shadow: var(--shadow); }
  .metric-label { color: var(--muted); font-size: 13px; margin-bottom: 8px; }
  .metric { font-size: 34px; font-weight: 800; letter-spacing: -.03em; }
  .hint { color: var(--muted); font-size: 13px; margin-top: 8px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 700; }
  .pill.up { color: var(--green); background: #ecfdf5; }
  .pill.down { color: var(--red); background: #fef2f2; }
  .pill.flat { color: var(--muted); background: #f1f5f9; }
  .wide { grid-column: 1 / -1; }
  .split { display: grid; grid-template-columns: 1.2fr .8fr; gap: 16px; }
  h2 { margin: 0 0 16px; font-size: 20px; }
  .overview-card { margin-bottom: 16px; }
  .overview-list { display: grid; grid-template-columns: minmax(120px, .8fr) minmax(120px, .8fr) minmax(280px, 1.65fr) minmax(220px, 1.25fr); gap: 12px; }
  .overview-item { min-width: 0; padding: 14px 16px; border: 1px solid #eef2f7; border-radius: 16px; background: #f8fafc; }
  .overview-label { display: block; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; }
  .overview-value { display: block; margin-top: 7px; color: var(--text); font-size: 20px; font-weight: 800; line-height: 1.35; word-break: normal; }
  .chart { display: grid; grid-template-columns: repeat(${Math.max(chartEntries.length, 1)}, minmax(24px, 1fr)); align-items: end; gap: 8px; min-height: 230px; overflow-x: auto; padding-bottom: 4px; }
  .bar-item { min-width: 24px; text-align: center; display: grid; grid-template-rows: 22px 166px 20px; align-items: end; }
  .bar-value { color: #94a3b8; font-size: 11px; white-space: nowrap; }
  .bar-track { height: 166px; display: flex; align-items: end; justify-content: center; }
  .bar { width: 100%; max-width: 24px; border-radius: 8px 8px 3px 3px; background: linear-gradient(180deg, #60a5fa, #2563eb); box-shadow: 0 8px 18px rgba(37,99,235,.22); }
  .bar-date { color: var(--muted); font-size: 11px; transform: rotate(-42deg); transform-origin: top center; margin-top: 8px; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #eef2f7; padding: 11px 8px; text-align: left; font-size: 14px; vertical-align: top; }
  th { color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; background: #f8fafc; border: 1px solid #eef2f7; border-radius: 7px; padding: 2px 6px; }
  .mini-meter { height: 8px; border-radius: 99px; background: #eef2f7; overflow: hidden; min-width: 80px; }
  .mini-meter span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #93c5fd, #2563eb); }
  .ua { color: var(--muted); max-width: 420px; word-break: break-word; font-size: 12px; }
  .donut-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
  .donut-card { background: #f9fbff; border: 1px solid #e2e8f0; border-radius: 18px; padding: 16px; }
  .donut-card h3 { margin: 0 0 12px; font-size: 14px; color: var(--text); font-weight: 700; letter-spacing: .02em; }
  .donut-row { display: flex; align-items: center; gap: 14px; }
  .donut { width: 130px; height: 130px; border-radius: 50%; position: relative; flex-shrink: 0; box-shadow: 0 8px 20px rgba(15, 23, 42, .08); }
  .donut-hole { position: absolute; inset: 18px; background: #ffffff; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; text-align: center; }
  .donut-top-label { font-size: 12px; color: var(--muted); }
  .donut-top-value { font-size: 22px; font-weight: 800; color: var(--text); line-height: 1; }
  .donut-legend { list-style: none; margin: 0; padding: 0; flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .donut-legend li { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #334155; }
  .donut-legend .swatch { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
  .donut-legend .legend-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .donut-legend .legend-meta { color: var(--muted); font-variant-numeric: tabular-nums; }
  @media (max-width: 860px) { .donut-grid { grid-template-columns: 1fr; } }
  .empty { padding: 52px 16px; text-align: center; color: var(--muted); }
  footer { margin-top: 18px; color: #94a3b8; font-size: 12px; text-align: center; }
  @media (max-width: 960px) { .overview-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 860px) { header { display: block; } .actions { justify-content: flex-start; margin-top: 14px; } .grid { grid-template-columns: repeat(2, 1fr); } .split { grid-template-columns: 1fr; } }
  @media (max-width: 560px) { main { width: min(100vw - 20px, 1120px); padding-top: 18px; } .grid, .overview-list { grid-template-columns: 1fr; } .card { border-radius: 18px; padding: 16px; } th, td { font-size: 12px; padding: 9px 6px; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>福利页访问统计</h1>
      <p class="sub">页面：<strong>本页面</strong>。这里把原始 JSON 整理成 PV、UV、趋势、页面排行和每日明细。</p>
    </div>
    <div class="actions">
      <a class="btn primary" href="/">打开福利页</a>
      <a class="btn" href="${escapeHtml(jsonHref)}">查看原始 JSON</a>
    </div>
  </header>

  <section class="grid">
    <div class="card"><div class="metric-label">总浏览 PV</div><div class="metric">${fmt(summary.total)}</div><div class="hint">累计 ${fmt(meta.days)} 天</div></div>
    <div class="card"><div class="metric-label">总访客 UV</div><div class="metric">${fmt(meta.totalUV)}</div><div class="hint">按 IP 去重估算</div></div>
    <div class="card"><div class="metric-label">今日 PV / UV</div><div class="metric">${fmt(summary.today)} / ${fmt(summary.todayUV)}</div><div class="hint">UTC 日期口径</div></div>
    <div class="card"><div class="metric-label">近 7 天 PV</div><div class="metric">${fmt(meta.last7PV)}</div><div class="hint"><span class="pill ${trend.cls}">${trend.label}</span> 对比前 7 天</div></div>
  </section>

  <section class="card overview-card">
    <h2>概览</h2>
    <div class="overview-list">
      <div class="overview-item"><span class="overview-label">近 7 天 UV</span><strong class="overview-value">${fmt(meta.last7UV)}</strong></div>
      <div class="overview-item"><span class="overview-label">日均 PV</span><strong class="overview-value">${fmt(meta.avgPV)}</strong></div>
      <div class="overview-item"><span class="overview-label">峰值日期</span><strong class="overview-value">${meta.peakDay ? `${escapeHtml(meta.peakDay.day)} · ${fmt(meta.peakDay.pv)} PV / ${fmt(meta.peakDay.uv)} UV` : '-'}</strong></div>
      <div class="overview-item"><span class="overview-label">生成时间</span><strong class="overview-value">${escapeHtml(generatedAt)}</strong></div>
    </div>
  </section>

  <section class="card" style="margin-bottom:16px">
    <h2>📲 PWA 与订阅</h2>
    <div class="grid" style="margin-bottom:0">
      <div class="card"><div class="metric-label">📲 桌面安装（独立设备）</div><div class="metric">${fmt(engagement.installUniqueDevices)}</div><div class="hint">以 PWA 方式打开的去重设备 · 累计打开 ${fmt(engagement.standaloneOpens)} 次</div></div>
      <div class="card"><div class="metric-label">🔔 发薪日订阅（疑似真人）</div><div class="metric">${fmt(engagement.subsPeople)}</div><div class="hint">按 IP+UA 去重 · 生效订阅 ${fmt(engagement.subsEnabled)} 条（含重装）· 共 ${fmt(engagement.subsTotal)} 条</div></div>
      <div class="card"><div class="metric-label">🖱️ 安装事件</div><div class="metric">${fmt(engagement.installEvents)}</div><div class="hint">appinstalled 触发次数（iOS 不计）</div></div>
      <div class="card"><div class="metric-label">📌 订阅 / 安装转化</div><div class="metric">${engagement.installUniqueDevices ? Math.round((engagement.subsEnabled / engagement.installUniqueDevices) * 100) : 0}%</div><div class="hint">生效订阅数 ÷ 安装设备数</div></div>
    </div>
  </section>

  <section class="card" style="margin-bottom:16px">
    <h2>最近 30 天趋势</h2>
    ${chartEntries.length ? `<div class="chart">${bars}</div>` : '<div class="empty">暂无访问数据</div>'}
  </section>

  <section class="split" style="margin-top:16px">
    <div class="card">
      <h2>城市分布</h2>
      ${cityRows.length ? `<table><thead><tr><th>城市</th><th>PV</th><th>UV</th><th>占比</th><th></th></tr></thead><tbody>${cities}</tbody></table>` : '<div class="empty">暂无城市数据</div>'}
    </div>
    <div class="card">
      <h2>页面排行</h2>
      ${pageRows.length ? `<table><thead><tr><th>页面</th><th>PV</th><th>占比</th><th></th></tr></thead><tbody>${pages}</tbody></table>` : '<div class="empty">暂无页面数据</div>'}
    </div>
  </section>

  <section class="card wide" style="margin-top:16px">
    <h2>🗂️ Tab 访问分布</h2>
    ${tabSection}
  </section>

  <section class="card wide" style="margin-top:16px">
    <h2>每日明细</h2>
    ${entries.length ? `<table><thead><tr><th>日期</th><th>PV</th><th>UV</th><th>UV/PV</th></tr></thead><tbody>${dayRows}</tbody></table>` : '<div class="empty">暂无每日数据</div>'}
  </section>

  <section class="card wide" style="margin-top:16px">
    <h2>User Agent 分布</h2>
    ${uaSection}
  </section>

  <section class="card wide" style="margin-top:16px">
    <h2>最近访问</h2>
    ${latest.length ? `<table><thead><tr><th>时间</th><th>页面</th><th>城市</th><th>IP</th><th>User Agent</th></tr></thead><tbody>${recent}</tbody></table>` : '<div class="empty">暂无最近访问</div>'}
  </section>

  <footer>原始数据来自 ${DATA_DIR}/pageviews.jsonl。UV 为 IP 去重估算，城市由 IP 粗略解析并缓存，可能受代理、网络出口影响。</footer>
</main>
</body>
</html>`;
}

// POST: 记录访问 / PWA 事件
export async function POST(req: Request) {
  let body: { page?: string; event?: string; id?: string } = {};
  try { body = await req.json(); } catch { /* empty body is ok */ }

  // PWA 安装 / 打开事件，单独存到 pwa-events.jsonl
  if (body.event) {
    const evt = {
      ts: new Date().toISOString(),
      event: String(body.event).slice(0, 40),
      id: body.id ? String(body.id).slice(0, 64) : '',
      ip: getClientIp(req),
      ua: req.headers.get('user-agent')?.slice(0, 300) ?? '',
    };
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.appendFile(PWA_EVENTS_FILE, JSON.stringify(evt) + '\n', 'utf-8');
    } catch { /* 写入失败不影响用户体验 */ }
    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  }

  const record = {
    ts: new Date().toISOString(),
    page: String(body.page ?? '/').slice(0, 200),
    ip: getClientIp(req),
    ua: req.headers.get('user-agent')?.slice(0, 300) ?? '',
    ref: req.headers.get('referer')?.slice(0, 500) ?? '',
  };

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(DATA_FILE, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    // 写入失败不影响用户体验
  }

  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

// GET: 查看统计
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');

  if (!hasAdminAccess(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const engagement = await readEngagement();

  let lines: string[] = [];
  try {
    const content = await fs.readFile(DATA_FILE, 'utf-8');
    lines = content.trim().split('\n').filter(Boolean);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      const { summary, meta } = emptyStats();
      if (wantsJson(req, url)) return NextResponse.json({ ...summary, tabs: [] });
      return new Response(renderStatsHtml(summary, meta, [], token, {}, engagement, { items: [], total: 0, totalUV: 0 }), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }
    return NextResponse.json({ error: '读取失败' }, { status: 500 });
  }

  const allRecords = lines
    .map<PageviewRecord | null>(line => { try { return JSON.parse(line) as PageviewRecord; } catch { return null; } })
    .filter((record): record is PageviewRecord => Boolean(record));
  // 拆分：tab 上报记录单独归类，不计入页面 PV/UV/城市 等统计
  const tabRecords = allRecords.filter(r => String(r.page || '').startsWith(TAB_PAGE_PREFIX));
  const records = allRecords.filter(r => !String(r.page || '').startsWith(TAB_PAGE_PREFIX));
  const { summary, meta } = buildStats(records);
  const tabStats = summarizeTabs(tabRecords);

  if (wantsJson(req, url)) return NextResponse.json({ ...summary, tabs: tabStats.items });
  const geoCache = await resolveGeo(records);
  return new Response(renderStatsHtml(summary, meta, records, token, geoCache, engagement, tabStats), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
  });
}
