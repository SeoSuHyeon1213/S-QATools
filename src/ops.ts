/**
 * 관제 도우미
 *  - log():     Workers Logs 가 필드별로 찾을 수 있게 JSON 한 줄로 남김 (대시보드에서 event = "report" 처럼 거르기)
 *  - count():   시간별 사건 수를 D1 에 더함 → 관리자 페이지 「관제」 탭
 *  - failure(): 서버 오류를 남기고, 디스코드로 알림 (같은 종류는 10분에 한 번)
 *  - checkHealth(): D1·R2 가 응답하는지
 */

export interface OpsEnv {
  DB: D1Database;
  SHOTS: R2Bucket;
  DISCORD_WEBHOOK_URL?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}

export const HOUR = 60 * 60 * 1000;
const ALERT_GAP = 10 * 60 * 1000;

type Level = 'info' | 'warn' | 'error';

export function log(level: Level, event: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** 시간별 사건 수 +1 (실패해도 요청은 그대로) */
export function count(env: OpsEnv, ctx: ExecutionContext | null, event: string, projectId = '', n = 1) {
  const p = env.DB.prepare(
    `INSERT INTO ops_counters (hour, event, project_id, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(hour, event, project_id) DO UPDATE SET count = count + excluded.count`,
  )
    .bind(Math.floor(Date.now() / HOUR), event, projectId, n)
    .run()
    .catch((e) => log('warn', 'ops.count_failed', { counter: event, error: errMessage(e) }));
  if (ctx) ctx.waitUntil(p);
  return p;
}

// 같은 isolate 안에서는 D1 을 읽지 않고도 알림 간격을 지킴 (D1 이 죽었을 때 대비)
const lastAlert = new Map<string, number>();

/** 디스코드 알림. key 가 같으면 10분에 한 번만 */
export async function alert(env: OpsEnv, key: string, text: string, gap = ALERT_GAP): Promise<boolean> {
  if (!env.DISCORD_WEBHOOK_URL) return false;
  const now = Date.now();
  if (now - (lastAlert.get(key) ?? 0) < gap) return false;
  try {
    const row = await env.DB.prepare('SELECT at FROM ops_state WHERE key = ?').bind('alert:' + key).first<{ at: number }>();
    if (row && now - row.at < gap) return false;
    await env.DB.prepare('INSERT INTO ops_state (key, value, at) VALUES (?, NULL, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at')
      .bind('alert:' + key, now).run();
  } catch {
    /* D1 이 안 될 때도 알림은 보냄 */
  }
  lastAlert.set(key, now);
  try {
    const r = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return true;
  } catch (e) {
    log('warn', 'notify.failed', { key, error: errMessage(e) });
    count(env, null, 'notify.error');
    return false;
  }
}

/** 서버 오류: 로그 + 오류 목록 + 사건 수 + (10분에 한 번) 알림 */
export function failure(env: OpsEnv, ctx: ExecutionContext | null, source: string, e: unknown, ray: string | null, extra: Record<string, unknown> = {}) {
  const message = errMessage(e).slice(0, 1000);
  log('error', 'server.error', { source, error: message, stack: e instanceof Error ? e.stack : undefined, ray, ...extra });
  const work = Promise.allSettled([
    env.DB.prepare('INSERT INTO ops_errors (at, source, message, ray) VALUES (?, ?, ?, ?)').bind(Date.now(), source, message, ray).run(),
    count(env, null, source.startsWith('r2') ? 'r2.error' : 'server.error'),
    alert(env, 'error:' + source, `🚨 **QA 신고함 서버 오류** (${source})\n\`${message.slice(0, 300)}\`${ray ? `\nRay ID: ${ray}` : ''}`),
  ]);
  if (ctx) ctx.waitUntil(work);
  return work;
}

export interface Health {
  ok: boolean;
  db: { ok: boolean; ms: number; error?: string };
  r2: { ok: boolean; ms: number; error?: string };
  version: { id: string; tag: string | null; deployed_at: string | null } | null;
}

export async function checkHealth(env: OpsEnv): Promise<Health> {
  const timed = async (fn: () => Promise<unknown>) => {
    const t = Date.now();
    try {
      await fn();
      return { ok: true, ms: Date.now() - t };
    } catch (e) {
      return { ok: false, ms: Date.now() - t, error: errMessage(e).slice(0, 200) };
    }
  };
  const [db, r2] = await Promise.all([
    timed(() => env.DB.prepare('SELECT 1').first()),
    // head 는 값싼 읽기(Class B) — 없는 키여도 응답만 오면 정상
    timed(() => env.SHOTS.head('health-check')),
  ]);
  const v = env.CF_VERSION_METADATA;
  return {
    ok: db.ok && r2.ok,
    db,
    r2,
    version: v ? { id: v.id, tag: v.tag || null, deployed_at: v.timestamp || null } : null,
  };
}

/** /api/reports/12 → /api/reports/:id (로그에서 경로별로 묶기) */
export function routeName(method: string, path: string) {
  return method + ' ' + path.replace(/\/\d+(?=\/|$)/g, '/:id');
}
