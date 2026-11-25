// 끝에서 끝까지 확인: `npm run dev` 를 켜 둔 상태에서 `npm run test:e2e`
// BASE, ADMIN_KEY 를 환경 변수로 바꿀 수 있음 (기본: localhost:8787, .dev.vars 의 ADMIN_KEY)
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
const ORIGIN = process.env.ORIGIN || BASE;
let KEY = process.env.ADMIN_KEY;
if (!KEY) {
  try { KEY = /^ADMIN_KEY=(.*)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1].trim(); } catch { /* 아래에서 실패 */ }
}

let pass = 0, failed = 0;
const created = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✔', name); } else { failed++; console.log('  ✘', name, extra); }
}
async function report(body, origin = ORIGIN) {
  const r = await fetch(BASE + '/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (j.id) created.push(j.id);
  return { status: r.status, body: j, acao: r.headers.get('access-control-allow-origin') };
}
async function admin(path, opts = {}, key = KEY) {
  const r = await fetch(BASE + '/api/admin' + path, { ...opts, headers: { Authorization: 'Bearer ' + key, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, ct, body: ct.includes('json') ? await r.json() : await r.arrayBuffer() };
}

// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const sample = {
  project: 'demo', kind: 'bug', message: '스모크 테스트: 씨 뿌리기 단계에서 단추가 안 눌림', version: '0.1.0', channel: 'test', platform: 'web',
  context: { stage: 2, scene: '밭' }, env: { viewport: '800x400', input: 'touch' },
  trail: [{ ago: 13000, kind: '단계', text: '2단계 시작', n: 1 }, { ago: 5000, kind: '누름', text: '넘기기', n: 3 }, { ago: 4900, kind: 'error', text: "TypeError: Cannot read properties of null", n: 1 }],
  shot: PNG,
};

try {
  console.log(`대상: ${BASE}`);
  const h = await fetch(BASE + '/api/health').then((r) => r.json());
  check('health', h.ok === true);

  console.log('신고 받기');
  const pre = await fetch(BASE + '/api/reports', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  check('CORS preflight 204', pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN);
  const ok = await report(sample);
  check('정상 신고 201 + id', ok.status === 201 && ok.body.id > 0, JSON.stringify(ok));
  check('CORS 헤더에 출처', ok.acao === ORIGIN);
  const id = ok.body.id;

  const evil = await report({ ...sample, shot: undefined }, 'https://evil.example');
  check('허용 안 된 주소 403', evil.status === 403, JSON.stringify(evil));
  const unknown = await report({ ...sample, project: 'no-such-game' });
  check('없는 프로젝트 404', unknown.status === 404);
  const big = await report({ ...sample, shot: 'data:image/jpeg;base64,' + 'A'.repeat(1_000_000) });
  check('큰 사진 413', big.status === 413, JSON.stringify(big.body));
  const badShot = await report({ ...sample, shot: 'data:text/html;base64,PHNjcmlwdD4=' });
  check('사진 아닌 data URL 400', badShot.status === 400);
  const empty = await report({ project: 'demo', kind: 'bug', message: '' });
  check('빈 신고 400', empty.status === 400);
  const badKind = await report({ ...sample, kind: '<script>' , shot: undefined });
  check('이상한 kind 400', badKind.status === 400);
  const rated = await report({ project: 'demo', kind: 'fun', rating: 'good' });
  check('정도만 있는 재미 신고 201', rated.status === 201);

  console.log('관리자');
  check('열쇠 없으면 401', (await admin('/reports', {}, '')).status === 401);
  check('틀린 열쇠 401', (await admin('/reports', {}, 'wrong')).status === 401);
  const list = await admin('/reports?project=demo');
  check('목록에 방금 신고', list.status === 200 && list.body.reports.some((r) => r.id === id));
  const open = await admin('/reports?open=1&kind=bug');
  check('처리 안 됨 + 종류 거르기', open.body.reports.every((r) => r.kind === 'bug' && !['done', 'wontfix'].includes(r.status)));
  const search = await admin('/reports?q=' + encodeURIComponent('씨 뿌리기'));
  check('글 찾기', search.body.reports.some((r) => r.id === id));
  const d = await admin('/reports/' + id);
  check('상세: 3분 기록·진행 상황·사진 표시', d.body.report.trail.length === 3 && d.body.report.context.stage === 2 && d.body.report.has_shot === true);
  check('상세에 ip_hash·shot_key 노출 안 됨', !('ip_hash' in d.body.report) && !('shot_key' in d.body.report));
  const shot = await admin('/reports/' + id + '/shot');
  check('사진 내려받기 (image/png)', shot.status === 200 && shot.ct === 'image/png' && shot.body.byteLength > 50);

  const p1 = await admin('/reports/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'confirmed', severity: 'major', priority: 'p1' }) });
  check('상태 → 확인, 심각도·우선순위', p1.status === 200 && p1.body.report.status === 'confirmed' && p1.body.events.length === 3);
  const p2 = await admin('/reports/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'done', dev_note: '원인: null\n고친 것: 확인 추가\n확인 방법: 2단계 재시도', fixed_in: '0.1.1' }) });
  check('상태 → 완료, resolved_at 기록', p2.body.report.status === 'done' && p2.body.report.resolved_at > 0);
  const p3 = await admin('/reports/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'fixing' }) });
  check('완료 취소 → resolved_at 지움', p3.body.report.resolved_at === null);
  await admin('/reports/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  const bad = await admin('/reports/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'nope' }) });
  check('이상한 상태 400', bad.status === 400);

  const st = await admin('/stats?project=demo');
  check('통계: 완료 수와 평균 처리 일수', st.body.done >= 1 && st.body.avg_resolve_days !== null && st.body.by_kind.length > 0);

  const projects = await admin('/projects');
  const demo = projects.body.projects.find((p) => p.id === 'demo');
  check('막힌 주소 기록', demo.rejections.some((r) => r.origin === 'https://evil.example'));
  const badProj = await admin('/projects', { method: 'POST', body: JSON.stringify({ id: 'Bad ID!', name: 'x' }) });
  check('잘못된 프로젝트 id 400', badProj.status === 400);
  const badOrigin = await admin('/projects/demo', { method: 'PATCH', body: JSON.stringify({ allowed_origins: ['javascript:alert(1)'] }) });
  check('잘못된 허용 주소 400', badOrigin.status === 400);
  const resetOrigins = await admin('/projects/demo', { method: 'PATCH', body: JSON.stringify({ allowed_origins: demo.allowed_origins }) });
  check('허용 주소 저장 (막힌 기록 정리)', resetOrigins.status === 200);

  console.log('한 시간 한도');
  let limited = false;
  for (let i = 0; i < 15 && !limited; i++) {
    const r = await report({ project: 'demo', kind: 'other', message: '한도 시험 ' + i });
    if (r.status === 429) limited = true;
  }
  check('같은 곳에서 너무 많으면 429', limited);
} catch (e) {
  failed++;
  console.error('  ✘ 예외', e);
} finally {
  // 시험으로 만든 신고 지우기 (한도 계산에서도 빠짐)
  for (const id of created) await admin('/reports/' + id, { method: 'DELETE' });
  console.log(`\n정리: 시험 신고 ${created.length}건 삭제`);
  console.log(`결과: 통과 ${pass} · 실패 ${failed}`);
  process.exit(failed ? 1 : 0);
}
