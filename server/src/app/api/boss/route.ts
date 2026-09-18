/**
 * @file /api/boss - 匿名老板打分（避雷榜）
 *
 * 设计取向：用「结构化打分」替代「自由文本吐槽」。
 *   - 不接受任何自由文本评价，只接受 1-5 分的固定维度 + 预设标签。
 *     结构化评分属于主观意见，比自由文本的事实性指控法律风险低得多，
 *     也让打分者更难通过措辞被反向定位（这正是社区提出打分替代吐槽的原因）。
 *   - 未达最小样本量（MIN_SAMPLE）的条目一律不展示分数，只显示"样本积累中"。
 *     这同时解决两件事：① 单人无法把某个老板的分数打穿（防"狗急跳墙"）；
 *     ② N 太小时被打分者能反推出是谁打的，阈值保护了打分者。
 *   - 同一匿名指纹对同一条目只保留最新一票，避免刷分。
 *
 * GET:    聚合结果（达标条目给分数，未达标只给样本数）
 * GET ?raw=1&token=ADMIN_TOKEN   原始记录（治理用）
 * POST:   提交一次打分 { codename, org, scores{}, tags[] }，找不到条目则自动创建
 * DELETE: 管理员删除条目或单条打分（需 token）
 *
 * 存储：${BENEFITS_DATA_DIR}/boss-ratings.jsonl（release 之外，跨发布持久化）
 * 隐私：落盘保留 ip/ua 仅供治理；对外只返回聚合值，绝不返回单条打分或 ip/ua
 */

import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, hasAdminAccess, bossAnonSalt, hasBossAnonSalt } from '../../../lib/config';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


const DATA_FILE = path.join(DATA_DIR, 'boss-ratings.jsonl');



// 私有模式：默认开启，读/写都需要 ?token=ADMIN_TOKEN。设 BOSS_PUBLIC=1 后对所有人开放
// （敏感功能默认不对公网开放，确认治理策略后再开启）
const BOSS_PUBLIC = process.env.BOSS_PUBLIC === '1';

/** 低于这个票数不展示任何分数——防单人打穿 + 保护打分者匿名性 */
const MIN_SAMPLE = 5;
/**
 * 解锁还要求票来自至少这么多个不同网段。
 * 没有登录体系时这是性价比最高的一道闸：一个人在一条宽带上把 localStorage 清空反复投，
 * 网段始终只有 1 个，永远解锁不了；而真实人群天然会混着办公网 / 家宽 / 移动网络。
 * 注意不能设太高——微软办公网是同一个 NAT 出口，同事们大量共享同一网段。
 */
const MIN_NETS = 2;
/**
 * 单一网段最多能占总票数的比例。超过就视为证据不够独立，保持锁定。
 * 这是挡住"一个人一条线路灌票"的主要闸门——他的占比只会趋近 100%。
 */
const MAX_NET_SHARE = 0.5;
const MAX_CODENAME = 24;
const MAX_ORG = 24;
const MAX_TAGS = 4;
/**
 * 限流按「投票人」而不是按 IP——办公网 NAT 后面几十个同事共用一个出口，
 * 按 IP 限流会让他们互相挡住。IP 层另设一个宽松的突发上限来挡脚本洪水。
 */
const RATE_LIMIT_MS = Number(process.env.BOSS_RATE_LIMIT_MS || 10 * 1000);
const IP_BURST_WINDOW_MS = Number(process.env.BOSS_IP_BURST_WINDOW_MS || 60 * 1000);
const IP_BURST_MAX = Number(process.env.BOSS_IP_BURST_MAX || 20);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const lastByVoter = new Map<string, number>();
const burstByIp = new Map<string, number[]>();

/** IP 层突发保护：窗口内超过上限就拒，挡住脚本批量灌票（但不影响 NAT 下的正常同事） */
function ipBurstExceeded(ip: string, now: number): boolean {
  const hits = (burstByIp.get(ip) || []).filter(t => now - t < IP_BURST_WINDOW_MS);
  hits.push(now);
  burstByIp.set(ip, hits);
  return hits.length > IP_BURST_MAX;
}

/** 打分维度：均为主观评价，分数越高越正面（含"作息强度"——高分=不压迫） */
export const DIMENSIONS = [
  { key: 'pro', label: '专业能力', hint: '技术/业务判断力靠不靠谱' },
  { key: 'respect', label: '尊重沟通', hint: '是否好好说话、尊重下属' },
  { key: 'shield', label: '扛事担当', hint: '出事扛得住还是甩锅' },
  { key: 'growth', label: '成长晋升', hint: '给不给机会、晋升是否公平' },
  { key: 'balance', label: '作息强度', hint: '分越高 = 越不压迫作息' },
] as const;

type DimKey = (typeof DIMENSIONS)[number]['key'];
const DIM_KEYS = DIMENSIONS.map(d => d.key) as DimKey[];

/** 预设标签白名单：只允许从这里选，杜绝自由文本 */
export const TAGS = {
  positive: ['技术过硬', '扛事不甩锅', '给机会', '说话算话', '尊重边界', '晋升靠谱'],
  negative: ['画饼大师', '甩锅侠', '朝令夕改', '抢功劳', '爱PUA', '卡晋升', '夺命连环call'],
} as const;
const ALL_TAGS = new Set<string>([...TAGS.positive, ...TAGS.negative]);

interface RatingRecord {
  id: string;
  ts: string;
  bossId: string;
  codename: string;
  org: string;
  anon: string;
  net: string;
  scores: Record<DimKey, number>;
  tags: string[];
  ip?: string;
  ua?: string;
}

interface BossGroup {
  bossId: string;
  codename: string;
  org: string;
  count: number;
  locked: boolean;
  /** 票数已够但来源网段太单一——通常意味着这些票来自同一条线路 */
  needsMoreNets: boolean;
  minSample: number;
  overall: number | null;
  dims: Record<DimKey, number> | null;
  tags: { tag: string; count: number }[];
  lastRatedAt: string;
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

function anonFingerprint(seed: string): string {
  return crypto.createHash('sha256').update(seed + bossAnonSalt()).digest('hex').slice(0, 6);
}

/**
 * 网段键：IPv4 取前三段（/24），IPv6 取前四组（≈/64）。
 * 用来判断票是否来自多个不同接入点，而不是同一条线路刷出来的。
 */
function netKey(ip: string): string {
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
  const parts = ip.split('.');
  return parts.length === 4 ? parts.slice(0, 3).join('.') : ip;
}

/**
 * 投票人身份：优先用客户端 localStorage 里的设备 id（cid），退化到 IP。
 * 必须优先 cid——否则同一 NAT 出口后面的所有同事会被折叠成一票，
 * 办公网里根本凑不满解锁票数。cid 可被清除，所以它只负责"区分人"，
 * 防刷靠 MIN_NETS + 去极值 + 限流那几层。
 */
function voterKey(cid: string, ip: string): string {
  return cid ? anonFingerprint('cid:' + cid) : anonFingerprint('ip:' + ip);
}

function hasAccess(url: URL): boolean {
  if (BOSS_PUBLIC) return true;
  return hasAdminAccess(url.searchParams.get('token'));
}

/** 清掉控制字符和多余空白；代号/组织都只留短文本 */
function sanitizeLabel(value: unknown, max: number): string {
  return String(value ?? '')
    .split('').filter(ch => ch.charCodeAt(0) >= 32).join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 条目主键：组织 + 代号归一化，避免大小写/空格造成重复条目 */
function bossKey(org: string, codename: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  return crypto.createHash('sha256').update(`${norm(org)}|${norm(codename)}`).digest('hex').slice(0, 10);
}

/**
 * 代号合规性检查：挡掉一眼就是真实身份的输入。
 * 只能挡住最明显的情况（邮箱/alias/@），真正的兜底是人工治理 + 结构化打分本身。
 */
function codenameIssue(codename: string): string | null {
  if (!codename) return '请填写老板代号';
  if (codename.length < 2) return '代号至少 2 个字';
  if (/[@]/.test(codename) || /\.(com|cn|net)/i.test(codename)) return '代号不要填邮箱或域名';
  if (/^[a-z]+$/i.test(codename) && codename.length <= 8) return '代号看起来像 alias，请换一个只有圈内人看得懂的绰号';
  return null;
}

function asScore(value: unknown): number | null {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * 用中位数而不是平均数。
 * 平均数会被一批极端票整体拽走（实测 6 票 4 分被灌 10 票 1 分后平均降到 2.1），
 * 中位数要被推动则需要污染票数超过总票数的一半，抗操纵能力强得多。
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseRecord(line: string): RatingRecord | null {
  try {
    const p = JSON.parse(line) as Partial<RatingRecord>;
    if (!p || typeof p !== 'object' || !p.bossId || !p.anon) return null;
    const scores = {} as Record<DimKey, number>;
    for (const key of DIM_KEYS) {
      const s = asScore((p.scores as Record<string, unknown> | undefined)?.[key]);
      if (s === null) return null;
      scores[key] = s;
    }
    return {
      id: String(p.id ?? ''),
      ts: typeof p.ts === 'string' ? p.ts : new Date(0).toISOString(),
      bossId: String(p.bossId),
      codename: sanitizeLabel(p.codename, MAX_CODENAME),
      org: sanitizeLabel(p.org, MAX_ORG),
      anon: String(p.anon),
      net: typeof p.net === 'string' ? p.net : (typeof p.ip === 'string' ? netKey(p.ip) : ''),
      scores,
      tags: Array.isArray(p.tags) ? p.tags.filter(t => ALL_TAGS.has(String(t))).slice(0, MAX_TAGS) : [],
      ip: typeof p.ip === 'string' ? p.ip : undefined,
      ua: typeof p.ua === 'string' ? p.ua : undefined,
    };
  } catch {
    return null;
  }
}

async function readRecords(): Promise<RatingRecord[]> {
  try {
    const content = await fs.readFile(DATA_FILE, 'utf-8');
    return content.split('\n').filter(Boolean).map(parseRecord).filter((r): r is RatingRecord => Boolean(r));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** 同一 anon 对同一 bossId 只保留最新一票 */
function dedupe(records: RatingRecord[]): RatingRecord[] {
  const latest = new Map<string, RatingRecord>();
  for (const r of records) {
    const key = `${r.bossId}|${r.anon}`;
    const prev = latest.get(key);
    if (!prev || r.ts > prev.ts) latest.set(key, r);
  }
  return [...latest.values()];
}

function aggregate(records: RatingRecord[]): BossGroup[] {
  const map = new Map<string, RatingRecord[]>();
  for (const r of dedupe(records)) {
    const list = map.get(r.bossId) || [];
    list.push(r);
    map.set(r.bossId, list);
  }

  return [...map.entries()]
    .map(([bossId, list]) => {
      const newest = list.reduce((a, b) => (b.ts > a.ts ? b : a));
      const count = list.length;
      // 统计各网段票数，用于判断证据是否足够独立
      const perNet = new Map<string, number>();
      for (const r of list) perNet.set(r.net, (perNet.get(r.net) || 0) + 1);
      const nets = [...perNet.keys()].filter(Boolean).length;
      const topNetShare = count ? Math.max(...perNet.values()) / count : 1;
      // 解锁三个条件：票数够、来源网段够、且没有哪个网段占了一半以上。
      // 第三条是关键——一个人在一条线路上灌再多票，占比只会更高，永远解锁不了；
      // 而这也意味着"5 个同事全在办公网 + 1 票外部"这种证据不够独立的情况同样保持锁定。
      const netDominated = topNetShare > MAX_NET_SHARE;
      const locked = count < MIN_SAMPLE || nets < MIN_NETS || netDominated;

      // 未达阈值：只回样本数，不回任何分数/标签，避免被反推
      if (locked) {
        return {
          bossId,
          codename: newest.codename,
          org: newest.org,
          count,
          locked,
          needsMoreNets: count >= MIN_SAMPLE && (nets < MIN_NETS || netDominated),
          minSample: MIN_SAMPLE,
          overall: null,
          dims: null,
          tags: [],
          lastRatedAt: newest.ts,
        } satisfies BossGroup;
      }

      const dims = {} as Record<DimKey, number>;
      for (const key of DIM_KEYS) {
        dims[key] = round1(median(list.map(r => r.scores[key])));
      }
      const overall = round1(DIM_KEYS.reduce((s, k) => s + dims[k], 0) / DIM_KEYS.length);

      const tagCount = new Map<string, number>();
      for (const r of list) {
        for (const t of r.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
      }
      const tags = [...tagCount.entries()]
        .map(([tag, c]) => ({ tag, count: c }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);

      return { bossId, codename: newest.codename, org: newest.org, count, locked, needsMoreNets: false, minSample: MIN_SAMPLE, overall, dims, tags, lastRatedAt: newest.ts } satisfies BossGroup;
    })
    .sort((a, b) => {
      if (a.locked !== b.locked) return a.locked ? 1 : -1;      // 已解锁的排前面
      if (!a.locked && !b.locked) return (b.count - a.count);    // 样本多的排前面
      return b.lastRatedAt.localeCompare(a.lastRatedAt);
    });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!hasAccess(url)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
  }

  let records: RatingRecord[];
  try {
    records = await readRecords();
  } catch {
    return NextResponse.json({ error: '读取失败' }, { status: 500, headers: corsHeaders });
  }

  const raw = url.searchParams.get('raw') === '1';
  if (raw) {
    if (!hasAdminAccess(url.searchParams.get('token'))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
    }
    return NextResponse.json({ total: records.length, records: [...records].reverse() }, { headers: corsHeaders });
  }

  return NextResponse.json(
    {
      minSample: MIN_SAMPLE,
      dimensions: DIMENSIONS,
      tags: TAGS,
      groups: aggregate(records),
      updatedAt: new Date().toISOString(),
    },
    { headers: corsHeaders }
  );
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!hasAccess(url)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
  }
  if (!hasBossAnonSalt()) {
    return NextResponse.json({ error: 'BOSS_ANON_SALT is not configured' }, { status: 503, headers: corsHeaders });
  }

  const ip = getClientIp(req);
  const now = Date.now();
  // IP 层只挡明显的脚本洪水，阈值放宽以免误伤 NAT 后面的正常同事
  if (ipBurstExceeded(ip, now)) {
    return NextResponse.json({ error: '当前网络提交过于频繁，请稍后再试' }, { status: 429, headers: corsHeaders });
  }

  let body: { codename?: unknown; org?: unknown; scores?: unknown; tags?: unknown; cid?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400, headers: corsHeaders });
  }

  // 按投票人限流（而非按 IP），NAT 后面的同事互不影响
  const voter = voterKey(String(body.cid ?? '').trim().slice(0, 64), ip);
  const last = lastByVoter.get(voter) || 0;
  if (now - last < RATE_LIMIT_MS) {
    const wait = Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000);
    return NextResponse.json({ error: `提交太频繁，请 ${wait} 秒后再试` }, { status: 429, headers: corsHeaders });
  }

  const codename = sanitizeLabel(body.codename, MAX_CODENAME);
  const org = sanitizeLabel(body.org, MAX_ORG) || '未填写';
  const issue = codenameIssue(codename);
  if (issue) {
    return NextResponse.json({ error: issue }, { status: 400, headers: corsHeaders });
  }

  const scores = {} as Record<DimKey, number>;
  for (const dim of DIMENSIONS) {
    const s = asScore((body.scores as Record<string, unknown> | undefined)?.[dim.key]);
    if (s === null) {
      return NextResponse.json({ error: `「${dim.label}」请打 1-5 分` }, { status: 400, headers: corsHeaders });
    }
    scores[dim.key] = s;
  }

  const tags = Array.isArray(body.tags)
    ? [...new Set(body.tags.map(t => String(t)).filter(t => ALL_TAGS.has(t)))].slice(0, MAX_TAGS)
    : [];

  const record: RatingRecord = {
    id: now.toString(36) + crypto.randomBytes(3).toString('hex'),
    ts: new Date().toISOString(),
    bossId: bossKey(org, codename),
    codename,
    org,
    anon: voter,
    net: netKey(ip),
    scores,
    tags,
    ip,
    ua: req.headers.get('user-agent')?.slice(0, 300) ?? '',
  };

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(DATA_FILE, JSON.stringify(record) + '\n', 'utf-8');
  } catch {
    return NextResponse.json({ error: '服务端写入失败' }, { status: 500, headers: corsHeaders });
  }

  lastByVoter.set(voter, now);
  const groups = aggregate(await readRecords());
  const mine = groups.find(g => g.bossId === record.bossId);
  return NextResponse.json(
    { ok: true, bossId: record.bossId, minSample: MIN_SAMPLE, group: mine ?? null, groups },
    { headers: corsHeaders }
  );
}

/** 管理员治理：?id=<单条打分 id> 删一票，?bossId=<id> 删整个条目 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  if (!hasAdminAccess(url.searchParams.get('token'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders });
  }

  const id = url.searchParams.get('id') || '';
  const bossId = url.searchParams.get('bossId') || '';
  if (!id && !bossId) {
    return NextResponse.json({ error: '需要 id 或 bossId' }, { status: 400, headers: corsHeaders });
  }

  let records: RatingRecord[];
  try {
    records = await readRecords();
  } catch {
    return NextResponse.json({ error: '读取失败' }, { status: 500, headers: corsHeaders });
  }

  const kept = records.filter(r => (id ? r.id !== id : r.bossId !== bossId));
  if (kept.length === records.length) {
    return NextResponse.json({ error: '未找到匹配记录' }, { status: 404, headers: corsHeaders });
  }

  try {
    await fs.writeFile(DATA_FILE, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf-8');
  } catch {
    return NextResponse.json({ error: '写入失败' }, { status: 500, headers: corsHeaders });
  }

  return NextResponse.json({ ok: true, removed: records.length - kept.length }, { headers: corsHeaders });
}
