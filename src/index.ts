/**
 * QA 신고함 — Cloudflare Worker
 *
 *  POST /api/reports              게임에서 보내는 신고 (공개, 프로젝트별 허용 주소만)
 *  GET  /api/health
 *  /api/admin/*                   관리자 페이지용 (Authorization: Bearer <ADMIN_KEY>)
 *
 * 정적 파일(public/): /admin 관리자 페이지, /sdk/qa-report.js 게임용 SDK, /demo 데모 게임
 */

import { alert, checkHealth, count, errMessage, failure, HOUR, log, routeName } from './ops';

export interface Env {
  DB: D1Database;
  SHOTS: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_KEY?: string;
  IP_SALT?: string;
  DISCORD_WEBHOOK_URL?: string;
  RATE_LIMIT_PER_HOUR?: string;
  MAX_SHOT_BYTES?: string;
  /** 알림 메시지에 넣을 관리자 페이지 주소 (예: https://qatool.<계정>.workers.dev) */
  PUBLIC_URL?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

const STATUSES = ['new', 'confirmed', 'fixing', 'done', 'wontfix'] as const;
const RESOLVED = new Set(['done', 'wontfix']);
const SEVERITIES = ['critical', 'major', 'minor', 'trivial'];
const PRIORITIES = ['p1', 'p2', 'p3'];
const RATINGS = ['good', 'meh', 'bad'];
const PLATFORMS = ['toss', 'gamejolt', 'web', 'other'];

const MAX_BODY_BYTES = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ───────────────────────────── 공통 도우미 ─────────────────────────────

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function str(v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, '글자 형식이 아닌 값이 있어요');
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function oneOf(v: unknown, allowed: readonly string[], field: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !allowed.includes(v)) throw new HttpError(400, `${field} 값이 올바르지 않아요`);
  return v;
}

function smallJson(v: unknown, maxChars: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'context/env 는 객체여야 해요');
  const s = JSON.stringify(v);
  if (s.length > maxChars) throw new HttpError(413, 'context/env 가 너무 커요');
  return s;
}

function cleanTrail(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new HttpError(400, 'trail 은 배열이어야 해요');
  const out = v.slice(-400).map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return {
      ago: Math.max(0, Math.round(Number(o.ago) || 0)),
      kind: String(o.kind ?? '').slice(0, 24),
      text: String(o.text ?? '').slice(0, 500),
      n: Math.max(1, Math.min(9999, Math.round(Number(o.n) || 1))),
    };
  });
  return JSON.stringify(out);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeRe(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** '*', 'native'(Origin 없음: 설치형 게임), 'null'(샌드박스 iframe), 와일드카드 'https://*.example.com' 지원 */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (allowed.includes('*')) return true;
  if (!origin) return allowed.includes('native');
  if (origin === 'null') return allowed.includes('null');
  const o = origin.toLowerCase();
  for (const a of allowed) {
    const p = a.toLowerCase().replace(/\/+$/, '');
    if (p === o) return true;
    if (p.includes('*')) {
      const re = new RegExp('^' + p.split('*').map(escapeRe).join('[a-z0-9.-]*') + '$');
      if (re.test(o)) return true;
    }
  }
  return false;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

function decodeShot(dataUrl: string, maxBytes: number): { bytes: Uint8Array; type: string; ext: string } {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, '화면 사진 형식이 올바르지 않아요 (jpeg/png/webp data URL)');
  // base64 길이로 먼저 거르면 디코딩 전에 큰 사진을 막을 수 있음
  if (Math.floor((m[2].length * 3) / 4) > maxBytes + 3) throw new HttpError(413, `화면 사진은 ${Math.round(maxBytes / 1024)}KB 이하만 받아요`);
  const bin = atob(m[2]);
  if (bin.length > maxBytes) throw new HttpError(413, `화면 사진은 ${Math.round(maxBytes / 1024)}KB 이하만 받아요`);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type: `image/${m[1]}`, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
}

async function readJsonBody(request: Request, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > limit) throw new HttpError(413, '보낸 내용이 너무 커요');
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, '보낸 내용이 너무 커요');
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'JSON 형식이 아니에요');
  }
}

// ───────────────────────────── 신고 받기 ─────────────────────────────

const KIND_LABEL: Record<string, string> = {
  bug: '🐞 오류', stuck: '🧭 막힘', art_sound: '🎨 그림·소리', fun: '😀 재미', lesson: '💡 교훈', suggestion: '💬 제안', other: '✏️ 그 밖',
};

const OUTCOME: Record<number, string> = {
  400: 'report.invalid', 403: 'report.rejected_origin', 404: 'report.unknown_project', 413: 'report.too_large', 429: 'report.rate_limited',
};

async function submitReport(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin);
  const ray = request.headers.get('CF-Ray');
  let projectId: string | null = null;
  try {
    const body = await readJsonBody(request);
    projectId = str(body.project, 64);
    if (!projectId) throw new HttpError(400, 'project 가 없어요');

    const project = await env.DB.prepare('SELECT id, name, allowed_origins, active FROM projects WHERE id = ?')
      .bind(projectId)
      .first<{ id: string; name: string; allowed_origins: string; active: number }>();
    if (!project || !project.active) throw new HttpError(404, '등록되지 않은 프로젝트예요');

    let allowed: string[] = [];
    try { allowed = JSON.parse(project.allowed_origins); } catch { /* 빈 목록 */ }
    if (!originAllowed(origin, allowed)) {
      await env.DB.prepare(
        `INSERT INTO origin_rejections (project_id, origin, count, last_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(project_id, origin) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      ).bind(project.id, origin ?? '(없음)', Date.now()).run();
      throw new HttpError(403, `허용되지 않은 주소에서 온 신고예요: ${origin ?? '(Origin 없음)'}`);
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
    const ipHash = (await sha256Hex(`${env.IP_SALT ?? 'dev-salt'}|${ip}`)).slice(0, 32);
    const limit = Number(env.RATE_LIMIT_PER_HOUR || 10);
    const now = Date.now();
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND created_at > ?')
      .bind(ipHash, now - HOUR)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= limit) throw new HttpError(429, '신고가 너무 많아요. 잠시 뒤에 다시 보내 주세요');

    const kind = str(body.kind, 24) ?? 'other';
    if (!/^[a-z][a-z0-9_]*$/.test(kind)) throw new HttpError(400, 'kind 값이 올바르지 않아요');
    const rating = oneOf(body.rating, RATINGS, 'rating');
    const message = str(body.message, 4000) ?? '';
    const shotUrl = typeof body.shot === 'string' && body.shot ? body.shot : null;
    if (!message && !rating && !shotUrl) throw new HttpError(400, '내용을 한 줄이라도 적어 주세요');

    // 사진은 R2 에, 데이터베이스에는 키만
    let shotKey: string | null = null;
    let shotBytes: number | null = null;
    if (shotUrl) {
      const shot = decodeShot(shotUrl, Number(env.MAX_SHOT_BYTES || 716800));
      const key = `shots/${project.id}/${new Date(now).toISOString().slice(0, 10)}/${crypto.randomUUID()}.${shot.ext}`;
      try {
        await env.SHOTS.put(key, shot.bytes, { httpMetadata: { contentType: shot.type } });
        shotKey = key;
        shotBytes = shot.bytes.length;
      } catch (e) {
        // 사진 없이라도 신고는 저장
        failure(env, ctx, 'r2.put', e, ray, { project: project.id });
      }
    }

    const row = await env.DB.prepare(
      `INSERT INTO reports (project_id, kind, rating, message, version, channel, platform, context, env, trail, shot_key, shot_bytes, ip_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(
        project.id, kind, rating, message,
        str(body.version, 40), str(body.channel, 20), str(body.platform, 20),
        smallJson(body.context, 4000), smallJson(body.env, 2000), cleanTrail(body.trail),
        shotKey, shotBytes, ipHash, now, now,
      )
      .first<{ id: number }>();
    const id = row!.id;
    count(env, ctx, 'report.accepted', project.id);
    log('info', 'report.accepted', { id, project: project.id, kind, channel: str(body.channel, 20), version: str(body.version, 40), shot: !!shotKey, trail: Array.isArray(body.trail) ? body.trail.length : 0 });

    if (env.DISCORD_WEBHOOK_URL) {
      const adminUrl = `${new URL(request.url).origin}/admin/#/r/${id}`;
      const line = `**[${project.name}] ${KIND_LABEL[kind] ?? kind}${rating ? ` (${rating})` : ''} #${id}**\n${message.slice(0, 300) || '(내용 없음)'}\n` +
        `판: ${str(body.channel, 20) ?? '-'} · ${str(body.version, 40) ?? '-'}  ${adminUrl}`;
      ctx.waitUntil(
        fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: line, allowed_mentions: { parse: [] } }),
        })
          .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); })
          .catch((e) => { log('warn', 'notify.failed', { id, error: errMessage(e) }); return count(env, null, 'notify.error'); }),
      );
    }

    return json({ ok: true, id }, 201, cors);
  } catch (e) {
    if (e instanceof HttpError) {
      const outcome = OUTCOME[e.status] ?? 'report.invalid';
      count(env, ctx, outcome, projectId ?? '');
      log('warn', outcome, { project: projectId, origin, reason: e.message });
      return json({ ok: false, error: e.message }, e.status, cors);
    }
    failure(env, ctx, 'report.submit', e, ray, { project: projectId });
    return json({ ok: false, error: '서버 오류' }, 500, cors);
  }
}

// ───────────────────────────── 관리자 ─────────────────────────────

async function checkAdmin(request: Request, env: Env, ctx: ExecutionContext) {
  if (!env.ADMIN_KEY) throw new HttpError(503, 'ADMIN_KEY 가 설정되지 않았어요 (wrangler secret put ADMIN_KEY)');
  const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(env.ADMIN_KEY)]);
  const enc = new TextEncoder();
  // @ts-ignore - Workers 런타임 전용 API
  const same = crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(enc.encode(a), enc.encode(b)) : a === b;
  if (!given || !same) {
    count(env, ctx, 'admin.auth_failed');
    log('warn', 'admin.auth_failed', { ip_country: request.headers.get('CF-IPCountry') });
    throw new HttpError(401, '관리자 열쇠가 맞지 않아요');
  }
}

const LIST_COLUMNS = `id, project_id, kind, rating, substr(message, 1, 200) AS message, version, channel, platform,
  status, severity, priority, assignee, fixed_in, shot_key IS NOT NULL AS has_shot, created_at, updated_at, resolved_at`;

async function listReports(url: URL, env: Env) {
  const where: string[] = [];
  const args: unknown[] = [];
  const p = url.searchParams;
  for (const f of ['project_id', 'status', 'kind', 'severity', 'priority', 'channel'] as const) {
    const key = f === 'project_id' ? 'project' : f;
    const v = p.get(key);
    if (v) { where.push(`${f} = ?`); args.push(v); }
  }
  if (p.get('open') === '1') where.push(`status NOT IN ('done', 'wontfix')`);
  const q = p.get('q');
  if (q) { where.push('(message LIKE ? OR dev_note LIKE ? OR trail LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const before = Number(p.get('before'));
  if (before > 0) { where.push('id < ?'); args.push(before); }
  const limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 50));
  const sql = `SELECT ${LIST_COLUMNS} FROM reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...args, limit).all();
  return json({ reports: results, next: results.length === limit ? (results[results.length - 1] as { id: number }).id : null });
}

async function getReport(id: number, env: Env) {
  const r = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!r) throw new HttpError(404, '없는 신고예요');
  const { results: events } = await env.DB.prepare('SELECT field, from_value, to_value, at FROM report_events WHERE report_id = ? ORDER BY at, id').bind(id).all();
  for (const k of ['context', 'env', 'trail']) {
    try { r[k] = r[k] ? JSON.parse(r[k] as string) : null; } catch { /* 그대로 */ }
  }
  r.has_shot = !!r.shot_key;
  delete r.shot_key;
  delete r.ip_hash;
  return json({ report: r, events });
}

async function updateReport(id: number, request: Request, env: Env) {
  const body = await readJsonBody(request, 64 * 1024);
  const cur = await env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!cur) throw new HttpError(404, '없는 신고예요');

  const next: Record<string, string | null> = {};
  if ('status' in body) next.status = oneOf(body.status, STATUSES, 'status') ?? 'new';
  if ('severity' in body) next.severity = oneOf(body.severity, SEVERITIES, 'severity');
  if ('priority' in body) next.priority = oneOf(body.priority, PRIORITIES, 'priority');
  if ('assignee' in body) next.assignee = str(body.assignee, 60);
  if ('dev_note' in body) next.dev_note = str(body.dev_note, 8000);
  if ('fixed_in' in body) next.fixed_in = str(body.fixed_in, 40);
  if ('kind' in body) {
    const k = str(body.kind, 24);
    if (!k || !/^[a-z][a-z0-9_]*$/.test(k)) throw new HttpError(400, 'kind 값이 올바르지 않아요');
    next.kind = k;
  }

  const changed = Object.entries(next).filter(([k, v]) => (cur[k] ?? null) !== v);
  if (!changed.length) return getReport(id, env);

  const now = Date.now();
  const sets = changed.map(([k]) => `${k} = ?`);
  const vals: unknown[] = changed.map(([, v]) => v);
  if (next.status !== undefined && next.status !== cur.status) {
    sets.push('resolved_at = ?');
    vals.push(RESOLVED.has(next.status!) ? (RESOLVED.has(cur.status as string) ? cur.resolved_at : now) : null);
  }
  sets.push('updated_at = ?');
  vals.push(now);

  const stmts = [env.DB.prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id)];
  for (const [k, v] of changed) {
    // 긴 메모는 이력에 앞부분만
    const clip = (x: unknown) => (x == null ? null : String(x).slice(0, 200));
    stmts.push(env.DB.prepare('INSERT INTO report_events (report_id, field, from_value, to_value, at) VALUES (?, ?, ?, ?, ?)').bind(id, k, clip(cur[k]), clip(v), now));
  }
  await env.DB.batch(stmts);
  return getReport(id, env);
}

async function deleteReport(id: number, env: Env) {
  const cur = await env.DB.prepare('SELECT shot_key FROM reports WHERE id = ?').bind(id).first<{ shot_key: string | null }>();
  if (!cur) throw new HttpError(404, '없는 신고예요');
  if (cur.shot_key) await env.SHOTS.delete(cur.shot_key);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM report_events WHERE report_id = ?').bind(id),
    env.DB.prepare('DELETE FROM reports WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function getShot(id: number, env: Env) {
  const r = await env.DB.prepare('SELECT shot_key FROM reports WHERE id = ?').bind(id).first<{ shot_key: string | null }>();
  if (!r?.shot_key) throw new HttpError(404, '사진이 없어요');
  const obj = await env.SHOTS.get(r.shot_key);
  if (!obj) throw new HttpError(404, '사진을 찾을 수 없어요');
  return new Response(obj.body, {
    headers: { 'Content-Type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
  });
}

async function stats(url: URL, env: Env) {
  const project = url.searchParams.get('project');
  const w = project ? 'WHERE project_id = ?' : '';
  const a = project ? [project] : [];
  const since = Date.now() - 14 * 24 * HOUR;
  const [byStatus, byKind, resolve, daily] = await env.DB.batch([
    env.DB.prepare(`SELECT status, COUNT(*) AS n FROM reports ${w} GROUP BY status`).bind(...a),
    env.DB.prepare(`SELECT kind, COUNT(*) AS n FROM reports ${w} GROUP BY kind ORDER BY n DESC`).bind(...a),
    env.DB.prepare(
      `SELECT COUNT(*) AS n, AVG(resolved_at - created_at) AS avg_ms FROM reports ${w ? w + ' AND' : 'WHERE'} status = 'done' AND resolved_at IS NOT NULL`,
    ).bind(...a),
    env.DB.prepare(
      `SELECT CAST((created_at - ?) / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM reports ${w ? w + ' AND' : 'WHERE'} created_at >= ? GROUP BY day ORDER BY day`,
    ).bind(since, ...a, since),
  ]);
  const r = (resolve.results[0] ?? {}) as { n: number; avg_ms: number | null };
  return json({
    by_status: byStatus.results,
    by_kind: byKind.results,
    done: r.n ?? 0,
    avg_resolve_days: r.avg_ms != null ? Math.round((r.avg_ms / (24 * HOUR)) * 10) / 10 : null,
    daily_since: since,
    daily: daily.results,
  });
}

function parseOrigins(v: unknown): string {
  if (!Array.isArray(v)) throw new HttpError(400, 'allowed_origins 는 배열이어야 해요');
  const list = v.map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
  for (const o of list) {
    if (!['*', 'native', 'null'].includes(o) && !/^https?:\/\/[a-z0-9.*-]+(:\d+)?\/?$/i.test(o)) {
      throw new HttpError(400, `주소 형식이 올바르지 않아요: ${o} (예: https://example.com)`);
    }
  }
  return JSON.stringify(list.map((o) => o.replace(/\/+$/, '')));
}

async function listProjects(env: Env) {
  const [projects, counts, rejections] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM projects ORDER BY created_at'),
    env.DB.prepare(`SELECT project_id, COUNT(*) AS total, SUM(status NOT IN ('done','wontfix')) AS open FROM reports GROUP BY project_id`),
    env.DB.prepare('SELECT * FROM origin_rejections ORDER BY last_at DESC LIMIT 100'),
  ]);
  const c = new Map((counts.results as { project_id: string; total: number; open: number }[]).map((x) => [x.project_id, x]));
  return json({
    projects: (projects.results as Record<string, unknown>[]).map((p) => ({
      ...p,
      allowed_origins: JSON.parse((p.allowed_origins as string) || '[]'),
      total: c.get(p.id as string)?.total ?? 0,
      open: c.get(p.id as string)?.open ?? 0,
      rejections: (rejections.results as Record<string, unknown>[]).filter((r) => r.project_id === p.id),
    })),
  });
}

async function createProject(request: Request, env: Env) {
  const b = await readJsonBody(request, 16 * 1024);
  const id = str(b.id, 40);
  if (!id || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) throw new HttpError(400, 'id 는 영어 소문자·숫자·- 로 2~40자');
  const name = str(b.name, 80);
  if (!name) throw new HttpError(400, '이름을 적어 주세요');
  const platform = oneOf(b.platform, PLATFORMS, 'platform') ?? 'web';
  const origins = parseOrigins(b.allowed_origins ?? []);
  const exists = await env.DB.prepare('SELECT 1 FROM projects WHERE id = ?').bind(id).first();
  if (exists) throw new HttpError(409, '이미 있는 id 예요');
  await env.DB.prepare('INSERT INTO projects (id, name, platform, allowed_origins, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, platform, origins, Date.now()).run();
  return json({ ok: true, id }, 201);
}

async function updateProject(id: string, request: Request, env: Env) {
  const b = await readJsonBody(request, 16 * 1024);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('name' in b) { const n = str(b.name, 80); if (!n) throw new HttpError(400, '이름을 적어 주세요'); sets.push('name = ?'); vals.push(n); }
  if ('platform' in b) { sets.push('platform = ?'); vals.push(oneOf(b.platform, PLATFORMS, 'platform') ?? 'web'); }
  if ('allowed_origins' in b) { sets.push('allowed_origins = ?'); vals.push(parseOrigins(b.allowed_origins)); }
  if ('active' in b) { sets.push('active = ?'); vals.push(b.active ? 1 : 0); }
  if (!sets.length) throw new HttpError(400, '바꿀 것이 없어요');
  const res = await env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  if (!res.meta.changes) throw new HttpError(404, '없는 프로젝트예요');
  if ('allowed_origins' in b) await env.DB.prepare('DELETE FROM origin_rejections WHERE project_id = ?').bind(id).run();
  return json({ ok: true });
}

// ───────────────────────────── 관제 ─────────────────────────────

async function setState(env: Env, key: string, value: unknown) {
  await env.DB.prepare('INSERT INTO ops_state (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at')
    .bind(key, JSON.stringify(value), Date.now()).run();
}

async function opsOverview(url: URL, env: Env) {
  const hours = Math.min(24 * 14, Math.max(1, Number(url.searchParams.get('hours')) || 24));
  const project = url.searchParams.get('project') || '';
  const nowHour = Math.floor(Date.now() / HOUR);
  const fromHour = nowHour - hours + 1;
  // 서버 오류처럼 게임과 상관없는 사건(project_id = '')은 게임을 골라도 함께 보임
  const pw = project ? `AND (project_id = ? OR project_id = '')` : '';
  const pa = project ? [project] : [];
  const [health, batch] = await Promise.all([
    checkHealth(env),
    env.DB.batch([
      env.DB.prepare(`SELECT hour, event, SUM(count) AS n FROM ops_counters WHERE hour >= ? ${pw} GROUP BY hour, event ORDER BY hour`).bind(fromHour, ...pa),
      env.DB.prepare('SELECT at, source, message, ray FROM ops_errors WHERE at >= ? ORDER BY at DESC LIMIT 30').bind(fromHour * HOUR),
      env.DB.prepare(`SELECT COUNT(*) AS reports, COALESCE(SUM(shot_key IS NOT NULL), 0) AS shots, COALESCE(SUM(shot_bytes), 0) AS shot_bytes,
        (SELECT COUNT(*) FROM report_events) AS events FROM reports`),
      env.DB.prepare(`SELECT MAX(created_at) AS at FROM reports ${project ? 'WHERE project_id = ?' : ''}`).bind(...pa),
      env.DB.prepare(`SELECT key, value, at FROM ops_state WHERE key NOT LIKE 'alert:%'`),
      env.DB.prepare('SELECT COUNT(*) AS n, MAX(last_at) AS last_at FROM origin_rejections'),
    ]),
  ]);
  const [counters, errors, storage, last, state, rejections] = batch;
  const totals: Record<string, number> = {};
  for (const c of counters.results as { event: string; n: number }[]) totals[c.event] = (totals[c.event] ?? 0) + c.n;
  const st = Object.fromEntries(
    (state.results as { key: string; value: string; at: number }[]).map((x) => {
      let v: unknown = x.value;
      try { v = JSON.parse(x.value); } catch { /* 그대로 */ }
      return [x.key, { value: v, at: x.at }];
    }),
  );
  const s0 = (storage.results[0] ?? {}) as Record<string, number>;
  return json({
    health,
    hours,
    from_hour: fromHour,
    now_hour: nowHour,
    counters: counters.results,
    totals,
    errors: errors.results,
    storage: { db_bytes: storage.meta.size_after ?? null, reports: s0.reports ?? 0, shots: s0.shots ?? 0, shot_bytes: s0.shot_bytes ?? 0, events: s0.events ?? 0 },
    last_report_at: (last.results[0] as { at: number | null } | undefined)?.at ?? null,
    cron: st['cron.last'] ?? null,
    daily: st['daily.last'] ?? null,
    rejections: rejections.results[0] ?? null,
    alerts: { discord: !!env.DISCORD_WEBHOOK_URL },
  });
}

async function testAlert(env: Env) {
  if (!env.DISCORD_WEBHOOK_URL) throw new HttpError(400, 'DISCORD_WEBHOOK_URL 이 설정되지 않았어요 (wrangler secret put DISCORD_WEBHOOK_URL)');
  const sent = await alert(env, 'test:' + Date.now(), '✅ QA 신고함 알림 시험입니다. 이 메시지가 보이면 알림이 연결된 거예요.', 0);
  if (!sent) throw new HttpError(502, '디스코드로 보내지 못했어요. 웹훅 주소를 확인하세요');
  return json({ ok: true });
}

function adminLink(env: Env, hash: string) {
  return env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/+$/, '')}/admin/${hash}` : '';
}

const MB = 1024 * 1024;

async function dailySummary(env: Env) {
  const since = Date.now() - 24 * HOUR;
  const fromHour = Math.floor(since / HOUR);
  const [kinds, open, done, ev, storage] = await env.DB.batch([
    env.DB.prepare('SELECT kind, COUNT(*) AS n FROM reports WHERE created_at >= ? GROUP BY kind ORDER BY n DESC').bind(since),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status NOT IN ('done', 'wontfix')`),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM reports WHERE status = 'done' AND resolved_at >= ?`).bind(since),
    env.DB.prepare('SELECT event, SUM(count) AS n FROM ops_counters WHERE hour >= ? GROUP BY event').bind(fromHour),
    env.DB.prepare('SELECT COALESCE(SUM(shot_bytes), 0) AS b FROM reports'),
  ]);
  const k = kinds.results as { kind: string; n: number }[];
  const total = k.reduce((a, x) => a + x.n, 0);
  const e = Object.fromEntries((ev.results as { event: string; n: number }[]).map((x) => [x.event, x.n]));
  const n = (r: D1Result) => (r.results[0] as { n: number } | undefined)?.n ?? 0;
  const lines = [
    `📊 **QA 신고함 하루 요약** (지난 24시간)`,
    `신고 ${total}건${total ? ' — ' + k.map((x) => `${KIND_LABEL[x.kind] ?? x.kind} ${x.n}`).join(', ') : ''}`,
    `완료 ${n(done)}건 · 처리 안 됨 ${n(open)}건`,
    `막힌 주소 ${e['report.rejected_origin'] ?? 0} · 한도 초과 ${e['report.rate_limited'] ?? 0} · 서버 오류 ${(e['server.error'] ?? 0) + (e['r2.error'] ?? 0)} · 열쇠 실패 ${e['admin.auth_failed'] ?? 0}`,
    `저장: DB ${((storage.meta.size_after ?? 0) / MB).toFixed(1)}MB / 사진 ${(((storage.results[0] as { b: number }).b ?? 0) / MB).toFixed(1)}MB`,
    adminLink(env, '#/ops'),
  ].filter(Boolean);
  const sent = await alert(env, 'daily', lines.join('\n'), 20 * HOUR);
  await setState(env, 'daily.last', { sent, total });
}

async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
  const t0 = Date.now();
  try {
    const health = await checkHealth(env);
    if (!health.ok) {
      log('error', 'health.failed', { db: health.db, r2: health.r2 });
      await alert(env, 'health', `🚨 **QA 신고함 점검 실패** — D1 ${health.db.ok ? '정상' : '이상: ' + health.db.error} / R2 ${health.r2.ok ? '정상' : '이상: ' + health.r2.error}`, HOUR);
    }

    // 지난 한 시간에 이상하게 많은 사건
    const lastHour = Math.floor(Date.now() / HOUR) - 1;
    const { results } = await env.DB.prepare('SELECT event, SUM(count) AS n FROM ops_counters WHERE hour = ? GROUP BY event').bind(lastHour).all<{ event: string; n: number }>();
    const m = Object.fromEntries(results.map((x) => [x.event, x.n]));
    const spikes: string[] = [];
    if ((m['report.rate_limited'] ?? 0) >= 20) spikes.push(`한도 초과 ${m['report.rate_limited']}번 — 누군가 신고를 퍼붓고 있을 수 있어요`);
    if ((m['report.rejected_origin'] ?? 0) >= 20) spikes.push(`막힌 주소 ${m['report.rejected_origin']}번 — 허용 주소가 바뀌었거나 다른 곳에서 보내고 있어요`);
    if ((m['admin.auth_failed'] ?? 0) >= 10) spikes.push(`관리자 열쇠 실패 ${m['admin.auth_failed']}번 — 열쇠를 바꾸는 것을 고려하세요`);
    if ((m['report.accepted'] ?? 0) >= 50) spikes.push(`한 시간에 신고 ${m['report.accepted']}건 — 큰 문제가 생겼을 수 있어요`);
    if (spikes.length) {
      log('warn', 'ops.spike', { hour: lastHour, counts: m });
      await alert(env, 'spike', `⚠️ **QA 신고함 지난 한 시간**\n- ${spikes.join('\n- ')}\n${adminLink(env, '#/ops')}`, 3 * HOUR);
    }

    // 하루 한 번 (UTC 0시 = 한국 오전 9시): 요약 + 오래된 관제 기록 정리
    if (new Date(controller.scheduledTime).getUTCHours() === 0) {
      await dailySummary(env);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM ops_counters WHERE hour < ?').bind(Math.floor(Date.now() / HOUR) - 24 * 35),
        env.DB.prepare('DELETE FROM ops_errors WHERE id NOT IN (SELECT id FROM ops_errors ORDER BY id DESC LIMIT 200)'),
      ]);
    }
    await setState(env, 'cron.last', { ok: health.ok, ms: Date.now() - t0, db_ms: health.db.ms, r2_ms: health.r2.ms });
    log('info', 'cron.done', { ok: health.ok, ms: Date.now() - t0 });
  } catch (e) {
    await failure(env, ctx, 'cron', e, null);
  }
}

async function handleAdmin(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  await checkAdmin(request, env, ctx);
  const path = url.pathname.replace(/^\/api\/admin/, '');
  const m = request.method;
  let r: RegExpExecArray | null;

  if (path === '/me' && m === 'GET') return json({ ok: true });
  if (path === '/stats' && m === 'GET') return stats(url, env);
  if (path === '/ops' && m === 'GET') return opsOverview(url, env);
  if (path === '/ops/test-alert' && m === 'POST') return testAlert(env);
  if (path === '/projects' && m === 'GET') return listProjects(env);
  if (path === '/projects' && m === 'POST') return createProject(request, env);
  if ((r = /^\/projects\/([a-z0-9-]+)$/.exec(path)) && m === 'PATCH') return updateProject(r[1], request, env);
  if (path === '/reports' && m === 'GET') return listReports(url, env);
  if ((r = /^\/reports\/(\d+)$/.exec(path))) {
    const id = Number(r[1]);
    if (m === 'GET') return getReport(id, env);
    if (m === 'PATCH') return updateReport(id, request, env);
    if (m === 'DELETE') return deleteReport(id, env);
  }
  if ((r = /^\/reports\/(\d+)\/shot$/.exec(path)) && m === 'GET') return getShot(Number(r[1]), env);
  throw new HttpError(404, '없는 주소예요');
}

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (url.pathname === '/api/reports') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
    if (request.method === 'POST') return submitReport(request, env, ctx);
    throw new HttpError(405, 'POST 만 받아요');
  }
  if (url.pathname === '/api/health') {
    // 외부 감시(UptimeRobot 등)용: 정상 200, D1·R2 중 하나라도 이상하면 503
    const h = await checkHealth(env);
    return json({ ok: h.ok, db: h.db.ok, r2: h.r2.ok, version: h.version?.id ?? null, time: Date.now() }, h.ok ? 200 : 503);
  }
  if (url.pathname.startsWith('/api/admin/')) return handleAdmin(request, env, url, ctx);
  if (url.pathname.startsWith('/api/')) throw new HttpError(404, '없는 주소예요');
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await route(request, env, ctx, url);
    } catch (e) {
      if (e instanceof HttpError) res = json({ ok: false, error: e.message }, e.status);
      else {
        failure(env, ctx, url.pathname.startsWith('/api/admin/') ? 'admin' : 'request', e, request.headers.get('CF-Ray'), { path: url.pathname });
        res = json({ ok: false, error: '서버 오류' }, 500);
      }
    }
    // 요청 한 줄 기록 — Workers Logs 에서 route / status / ms 로 거르고 묶기 (정상 health 는 잡음이라 뺌)
    if (url.pathname.startsWith('/api/') && !(url.pathname === '/api/health' && res.status === 200)) {
      const cf = (request as { cf?: { country?: string; colo?: string } }).cf;
      log(res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info', 'request', {
        route: routeName(request.method, url.pathname),
        status: res.status,
        ms: Date.now() - t0,
        ray: request.headers.get('CF-Ray'),
        country: cf?.country,
        colo: cf?.colo,
      });
    }
    return res;
  },
  scheduled,
} satisfies ExportedHandler<Env>;
