'use strict';
/* QA 신고함 관리자 페이지 — 빌드 없이 쓰는 바닐라 JS.
   신고 내용은 누구나 보낼 수 있으므로, 화면에 넣는 값은 모두 html`` 로 이스케이프합니다. */

// ───────────── 안전한 템플릿 ─────────────
const RAW = Symbol('raw');
const raw = (s) => ({ [RAW]: s });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toHtml(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(toHtml).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += toHtml(v) + strings[i + 1]; });
  return raw(out);
}
const mount = (el, tpl) => { el.innerHTML = tpl[RAW]; };
const $ = (sel, root = document) => root.querySelector(sel);

// ───────────── 이름표 ─────────────
const STATUS = [['new', '접수'], ['confirmed', '확인'], ['fixing', '수정 중'], ['done', '완료'], ['wontfix', '보류']];
const STATUS_LABEL = Object.fromEntries(STATUS);
const KINDS = { bug: '🐞 오류', stuck: '🧭 막힘', art_sound: '🎨 그림·소리', fun: '😀 재미', lesson: '💡 교훈', suggestion: '💬 제안', other: '✏️ 그 밖' };
const RATING = { good: '재미있었다', meh: '그저 그렇다', bad: '지루했다' };
const SEV = { critical: '치명', major: '큼', minor: '작음', trivial: '사소' };
const PRI = { p1: 'P1 바로', p2: 'P2 이번 판', p3: 'P3 나중' };
const PLATFORM = { toss: '앱인토스', gamejolt: '게임졸트', web: '웹', other: '그 밖' };
const TRAIL_KIND = { error: '오류', app: '앱', qa: '신고' };
const FIELD = { status: '상태', severity: '심각도', priority: '우선순위', assignee: '담당', dev_note: '처리 메모', fixed_in: '고친 판', kind: '종류' };
const kindLabel = (k) => KINDS[k] || k;

// ───────────── 상태 ─────────────
const S = {
  key: sessionStorage.getItem('qa-admin-key') || localStorage.getItem('qa-admin-key') || '',
  projects: [],
  project: localStorage.getItem('qa-admin-project') || '',
  filters: { status: 'open', kind: '', q: '' },
  list: [],
  next: null,
  current: null,
  stats: null,
  shotUrl: null,
};

// ───────────── 서버 ─────────────
async function api(path, opts = {}) {
  const headers = { Authorization: 'Bearer ' + S.key };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api/admin' + path, { ...opts, headers });
  if (r.status === 401) { logout(); throw new Error('관리자 열쇠가 맞지 않아요'); }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) { if (!r.ok) throw new Error('HTTP ' + r.status); return r; }
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

// ───────────── 도우미 ─────────────
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function fail(e) { console.error(e); toast('⚠ ' + (e.message || e)); }

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtRel(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  return Math.floor(s / 86400) + '일 전';
}
function fmtAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + '초 전';
  const m = Math.floor(s / 60), r = s % 60;
  return m + '분' + (r ? ' ' + r + '초' : '') + ' 전';
}
function fmtDur(ms) {
  const h = ms / 3600000;
  return h < 24 ? Math.max(1, Math.round(h)) + '시간' : Math.round((h / 24) * 10) / 10 + '일';
}
function trailLine(e) {
  return `${fmtAgo(e.ago)} [${TRAIL_KIND[e.kind] || e.kind}] ${e.text}${e.n > 1 ? ' ×' + e.n : ''}`;
}
function kvText(obj) {
  return obj ? Object.entries(obj).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : '-';
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('복사했어요');
}
const projectName = (id) => (S.projects.find((p) => p.id === id) || {}).name || id;

// ───────────── 로그인 ─────────────
function logout() {
  S.key = '';
  sessionStorage.removeItem('qa-admin-key');
  localStorage.removeItem('qa-admin-key');
  renderLogin();
}

function renderLogin(msg) {
  mount($('#app'), html`
    <form class="login" id="login">
      <h1>📣 QA 신고함</h1>
      <input type="password" name="key" placeholder="관리자 열쇠 (ADMIN_KEY)" autocomplete="current-password" required autofocus>
      <label><input type="checkbox" name="remember"> 이 컴퓨터에서 기억하기</label>
      <button class="btn primary">들어가기</button>
      ${msg ? html`<p class="sub">${msg}</p>` : ''}
    </form>`);
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    S.key = String(f.get('key'));
    try {
      await api('/me');
      (f.get('remember') ? localStorage : sessionStorage).setItem('qa-admin-key', S.key);
      start();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

// ───────────── 윗줄 ─────────────
function topBar(tab) {
  const st = S.stats;
  const count = (s) => (st ? (st.by_status.find((x) => x.status === s) || {}).n || 0 : 0);
  const total = st ? st.by_status.reduce((a, x) => a + x.n, 0) : 0;
  const open = total - count('done') - count('wontfix');
  return html`
    <header class="top">
      <h1>📣 QA 신고함</h1>
      <nav class="tabs">
        <a href="#/" class="${tab === 'reports' ? 'on' : ''}">신고</a>
        <a href="#/ops" class="${tab === 'ops' ? 'on' : ''}">관제</a>
        <a href="#/projects" class="${tab === 'projects' ? 'on' : ''}">게임 · 연결</a>
      </nav>
      <select id="projectSel" aria-label="게임 고르기">
        <option value="">모든 게임</option>
        ${S.projects.map((p) => html`<option value="${p.id}" ${p.id === S.project ? raw('selected') : ''}>${p.name}</option>`)}
      </select>
      <div class="stats">
        <span>전체<b>${total}</b></span>
        <span>처리 안 됨<b>${open}</b></span>
        <span>완료<b>${count('done')}</b></span>
        <span title="접수부터 완료까지 걸린 평균">평균 처리<b>${st && st.avg_resolve_days != null ? st.avg_resolve_days + '일' : '-'}</b></span>
        <button class="btn small" data-act="logout">나가기</button>
      </div>
    </header>`;
}

// ───────────── 신고 목록 + 상세 ─────────────
function renderReportsShell() {
  mount($('#app'), html`
    ${topBar('reports')}
    <div class="layout" id="layout">
      <section class="list">
        <div class="filters">
          <div class="seg" id="statusSeg">
            ${[['open', '처리 안 됨'], ['', '전체'], ...STATUS].map(([v, l]) => html`<button type="button" data-status="${v}" aria-pressed="${S.filters.status === v}">${l}</button>`)}
          </div>
          <div class="row">
            <select id="kindSel" aria-label="종류">
              <option value="">모든 종류</option>
              ${Object.entries(KINDS).map(([k, l]) => html`<option value="${k}" ${S.filters.kind === k ? raw('selected') : ''}>${l}</option>`)}
            </select>
            <input type="search" id="q" placeholder="글·기록 찾기" value="${S.filters.q}">
          </div>
        </div>
        <div class="items" id="items"></div>
        <div class="listfoot">
          <button class="btn small" data-act="more" id="more" hidden>더 보기</button>
          <button class="btn small" data-act="copy-triage" title="지금 목록을 Claude 에게 묶음 분류를 맡기는 글로 복사">🤖 묶어 분류 프롬프트</button>
        </div>
      </section>
      <section class="detail" id="detail"><p class="empty">왼쪽에서 신고를 고르세요.</p></section>
    </div>`);

  $('#statusSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.filters.status = b.dataset.status;
    for (const x of $('#statusSeg').children) x.setAttribute('aria-pressed', String(x === b));
    loadList();
  });
  $('#kindSel').addEventListener('change', (e) => { S.filters.kind = e.target.value; loadList(); });
  let qt;
  $('#q').addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { S.filters.q = e.target.value.trim(); loadList(); }, 300); });
  $('#items').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) location.hash = '#/r/' + b.dataset.id;
  });
}

function listQuery(before) {
  const p = new URLSearchParams();
  if (S.project) p.set('project', S.project);
  if (S.filters.status === 'open') p.set('open', '1');
  else if (S.filters.status) p.set('status', S.filters.status);
  if (S.filters.kind) p.set('kind', S.filters.kind);
  if (S.filters.q) p.set('q', S.filters.q);
  if (before) p.set('before', before);
  return '/reports?' + p;
}

async function loadList(append = false) {
  try {
    const data = await api(listQuery(append ? S.next : null));
    S.list = append ? S.list.concat(data.reports) : data.reports;
    S.next = data.next;
    renderItems();
  } catch (e) { fail(e); }
}

function renderItems() {
  const box = $('#items');
  if (!box) return;
  const cur = S.current && S.current.id;
  mount(box, S.list.length
    ? html`${S.list.map((r) => html`
        <button type="button" class="item ${r.id === cur ? 'on' : ''}" data-id="${r.id}">
          <div class="meta">
            <span>#${r.id}</span>
            <span class="pill ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>
            <span>${kindLabel(r.kind)}${r.rating ? ' · ' + (RATING[r.rating] || r.rating) : ''}</span>
            ${r.severity ? html`<span class="pill sev-${r.severity}">${SEV[r.severity]}</span>` : ''}
            ${r.has_shot ? '📷' : ''}
            <span style="margin-left:auto" title="${fmtTime(r.created_at)}">${fmtRel(r.created_at)}</span>
          </div>
          <div class="text">${r.message || '(내용 없음)'}</div>
          <div class="meta">${S.project ? '' : projectName(r.project_id) + ' · '}${r.channel || ''} ${r.version ? 'v' + r.version : ''} ${PLATFORM[r.platform] || r.platform || ''}</div>
        </button>`)}`
    : html`<p class="empty">조건에 맞는 신고가 없어요.</p>`);
  $('#more').hidden = !S.next;
}

async function loadStats() {
  try {
    S.stats = await api('/stats' + (S.project ? '?project=' + encodeURIComponent(S.project) : ''));
    const top = $('.top');
    if (top) top.outerHTML = topBar(currentTab())[RAW];
  } catch (e) { fail(e); }
}

async function openReport(id) {
  $('#layout').classList.add('has-detail');
  const box = $('#detail');
  try {
    const { report, events } = await api('/reports/' + id);
    S.current = report;
    S.current.events = events;
    renderDetail();
    renderItems();
  } catch (e) {
    mount(box, html`<p class="empty">${e.message}</p>`);
  }
}

function renderDetail() {
  const r = S.current;
  const box = $('#detail');
  const trail = Array.isArray(r.trail) ? r.trail : [];
  const errors = trail.filter((e) => e.kind === 'error').length;
  mount(box, html`
    <div class="head">
      <button class="btn small" data-act="back" title="목록으로">←</button>
      <h2>#${r.id} ${kindLabel(r.kind)}${r.rating ? ' · ' + (RATING[r.rating] || r.rating) : ''}</h2>
      <span class="pill ${r.status}">${STATUS_LABEL[r.status] || r.status}</span>
    </div>
    <div class="sub">
      ${projectName(r.project_id)} · ${r.channel || '-'} · ${r.version ? 'v' + r.version : '판 정보 없음'} · ${PLATFORM[r.platform] || r.platform || '-'}
      · ${fmtTime(r.created_at)} (${fmtRel(r.created_at)})
      ${r.resolved_at ? html` · 처리까지 ${fmtDur(r.resolved_at - r.created_at)}` : ''}
    </div>
    <div class="message">${r.message || '(내용 없음)'}</div>

    <div class="grid2">
      <div>
        ${r.has_shot ? html`<div class="card"><h3>화면 사진</h3><img class="shot" id="shot" alt="신고 순간의 게임 화면" data-act="zoom"></div>` : ''}
        <div class="card">
          <h3>최근 3분 기록 (${trail.length}줄${errors ? html`, <span style="color:var(--red)">오류 ${errors}</span>` : ''})</h3>
          ${trail.length
            ? html`<ol class="trail">${trail.map((e) => html`<li class="${e.kind === 'error' ? 'error' : ''}"><span class="ago">${fmtAgo(e.ago)}</span>[${TRAIL_KIND[e.kind] || e.kind}] ${e.text}${e.n > 1 ? html` <b>×${e.n}</b>` : ''}</li>`)}</ol>`
            : html`<p class="sub">기록 없음</p>`}
        </div>
        <div class="card"><h3>진행 상황 (게임이 보낸 것)</h3>${kv(r.context)}</div>
        <div class="card"><h3>환경</h3>${kv(r.env)}</div>
      </div>

      <div>
        <div class="card">
          <h3>처리 (접수 → 확인 → 수정 중 → 완료)</h3>
          <div class="flow" id="flow">
            ${STATUS.map(([v, l]) => html`<button type="button" data-status="${v}" aria-pressed="${r.status === v}">${l}</button>`)}
          </div>
        </div>
        <form class="card form" id="triage">
          <h3>분류와 메모</h3>
          <div class="two">
            <label>심각도<select name="severity"><option value="">-</option>${Object.entries(SEV).map(([v, l]) => html`<option value="${v}" ${r.severity === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
            <label>우선순위<select name="priority"><option value="">-</option>${Object.entries(PRI).map(([v, l]) => html`<option value="${v}" ${r.priority === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
            <label>종류<select name="kind">${Object.entries({ ...KINDS, ...(KINDS[r.kind] ? {} : { [r.kind]: r.kind }) }).map(([v, l]) => html`<option value="${v}" ${r.kind === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
            <label>담당<input type="text" name="assignee" value="${r.assignee || ''}" maxlength="60"></label>
          </div>
          <label>고친 판<input type="text" name="fixed_in" value="${r.fixed_in || ''}" placeholder="예: 0.1.3" maxlength="40"></label>
          <label>처리 메모 (원인 / 고친 것 / 확인 방법)<textarea name="dev_note" rows="5" placeholder="원인: &#10;고친 것: &#10;확인 방법: ">${r.dev_note || ''}</textarea></label>
          <button class="btn primary">저장</button>
        </form>
        <div class="card">
          <h3>처리 기록</h3>
          <ul class="events">
            <li>${fmtTime(r.created_at)} <b>접수</b></li>
            ${r.events.map((ev) => html`<li>${fmtTime(ev.at)} <b>${FIELD[ev.field] || ev.field}</b>: ${evVal(ev.field, ev.from_value)} → ${evVal(ev.field, ev.to_value)}</li>`)}
          </ul>
        </div>
        <div class="actions">
          <button class="btn" data-act="copy-claude" title="PDF 22쪽 '한 건 처리' 프롬프트 + 이 신고 내용">🤖 Claude 프롬프트 복사</button>
          <button class="btn" data-act="copy-reply">✉ 답장 초안 프롬프트</button>
          <button class="btn danger" data-act="delete">삭제</button>
        </div>
      </div>
    </div>`);

  $('#flow').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && b.dataset.status !== S.current.status) patch({ status: b.dataset.status });
  });
  $('#triage').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    patch(Object.fromEntries(['severity', 'priority', 'kind', 'assignee', 'fixed_in', 'dev_note'].map((k) => [k, String(f.get(k) || '')])));
  });
  loadShot();
}

function evVal(field, v) {
  if (v == null || v === '') return '-';
  if (field === 'status') return STATUS_LABEL[v] || v;
  if (field === 'severity') return SEV[v] || v;
  if (field === 'priority') return PRI[v] || v;
  if (field === 'kind') return kindLabel(v);
  return v.length > 40 ? v.slice(0, 40) + '…' : v;
}

function kv(obj) {
  if (!obj || !Object.keys(obj).length) return html`<p class="sub">없음</p>`;
  return html`<dl class="kv">${Object.entries(obj).map(([k, v]) => html`<dt>${k}</dt><dd>${typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>`)}</dl>`;
}

async function loadShot() {
  const img = $('#shot');
  if (!img) return;
  if (S.shotUrl) URL.revokeObjectURL(S.shotUrl);
  S.shotUrl = null;
  try {
    const res = await api('/reports/' + S.current.id + '/shot');
    S.shotUrl = URL.createObjectURL(await res.blob());
    img.src = S.shotUrl;
  } catch (e) {
    img.replaceWith(Object.assign(document.createElement('p'), { className: 'sub', textContent: '사진을 불러오지 못했어요: ' + e.message }));
  }
}

async function patch(body) {
  try {
    const { report, events } = await api('/reports/' + S.current.id, { method: 'PATCH', body: JSON.stringify(body) });
    S.current = report;
    S.current.events = events;
    const i = S.list.findIndex((x) => x.id === report.id);
    if (i >= 0) Object.assign(S.list[i], { status: report.status, severity: report.severity, kind: report.kind });
    renderDetail();
    renderItems();
    loadStats();
    toast('저장했어요');
  } catch (e) { fail(e); }
}

// ───────────── Claude 프롬프트 (PDF 22쪽) ─────────────
function reportText(r) {
  const trail = Array.isArray(r.trail) ? r.trail : [];
  return [
    `--- 신고 #${r.id} ---`,
    `게임: ${projectName(r.project_id)} (${r.project_id})`,
    `종류: ${kindLabel(r.kind)}${r.rating ? ' · ' + (RATING[r.rating] || r.rating) : ''}`,
    `판: ${r.channel || '-'} · ${r.version ? 'v' + r.version : '-'} · ${PLATFORM[r.platform] || r.platform || '-'}`,
    `받은 때: ${fmtTime(r.created_at)}`,
    `내용: ${r.message || '(없음)'}`,
    `진행 상황: ${kvText(r.context)}`,
    `환경: ${kvText(r.env)}`,
    `최근 3분 기록 (오래된 것부터):`,
    ...(trail.length ? trail.map((e) => '  ' + trailLine(e)) : ['  (없음)']),
    `화면 사진: ${r.has_shot ? `${location.origin}/admin/#/r/${r.id} 에서 확인` : '없음'}`,
  ].join('\n');
}

function claudeFixPrompt(r) {
  return `아래 신고를 처리해 줘.
① 3분 기록과 화면 정보대로 같은 상황을 재현하고 원인을 찾아.
② 가장 작게 고치고 자동 테스트를 돌려.
③ 테스트판에 올리고, 그 단계까지 진행해서 고쳐졌는지 확인해.
④ '원인 / 고친 것 / 확인 방법' 세 줄로 정리해 줘.
재현이 안 되면 고치지 말고 무엇이 더 필요한지 알려 줘. 운영판에는 올리지 마.

${reportText(r)}`;
}

function claudeReplyPrompt(r) {
  return `고친 내용으로 신고한 분께 보낼 짧은 답장을 써 줘. 고마움, 무엇이 바뀌었는지, 다시 해 볼 방법. 전문 용어는 빼.
${r.platform === 'gamejolt' ? '게임졸트 이용자라 영어와 한국어 두 가지로 써 줘.\n' : ''}
신고 내용: ${r.message || '(없음)'}
처리 메모: ${r.dev_note || '(없음)'}
고친 판: ${r.fixed_in || '(아직 없음)'}`;
}

function claudeTriagePrompt(list) {
  return `이번 신고 ${list.length}건이야. 같은 원인으로 보이는 것끼리 묶고, 심각도(치명/큼/작음/사소)와 우선순위(P1/P2/P3)를 매겨 표로 정리해 줘.
재미 신고는 게임·장면별로 요약하고, 고칠 것과 기획에 넘길 것을 나눠.

${list.map((r) => `#${r.id} [${projectName(r.project_id)} · ${r.channel || '-'} v${r.version || '-'}] ${kindLabel(r.kind)}${r.rating ? ' (' + (RATING[r.rating] || r.rating) + ')' : ''} · ${STATUS_LABEL[r.status]}: ${(r.message || '').replace(/\s+/g, ' ')}`).join('\n')}`;
}

// ───────────── 게임 · 연결 (프로젝트) ─────────────
async function renderProjects() {
  mount($('#app'), html`${topBar('projects')}<main class="page" id="page"><p class="empty">불러오는 중…</p></main>`);
  await refreshProjects();
  const page = $('#page');
  mount(page, html`
    <p class="sub">게임마다 신고를 나눠 받습니다. <b>허용 주소</b>는 그 게임이 실제로 열리는 주소(Origin)예요.
      처음엔 모를 수 있으니, 신고가 막히면 아래에 <b>막힌 주소</b>가 뜹니다 — 맞으면 [허용에 추가]를 누르세요.
      <code>*</code> 는 모든 곳, <code>https://*.example.com</code> 은 하위 주소 전체, <code>native</code> 는 설치형(주소 없음), <code>null</code> 은 샌드박스 iframe.</p>
    ${S.projects.map((p) => html`
      <form class="card proj" data-proj="${p.id}">
        <div class="head"><h2>${p.name}</h2><code>${p.id}</code><span class="pill">${PLATFORM[p.platform] || p.platform}</span>
          <span class="sub">신고 ${p.total}건 · 처리 안 됨 ${p.open}건</span></div>
        <div class="form">
          <div class="two">
            <label>이름<input type="text" name="name" value="${p.name}" required maxlength="80"></label>
            <label>플랫폼<select name="platform">${Object.entries(PLATFORM).map(([v, l]) => html`<option value="${v}" ${p.platform === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
          </div>
          <label>허용 주소 (한 줄에 하나)<textarea name="origins" rows="3">${p.allowed_origins.join('\n')}</textarea></label>
          <label><span><input type="checkbox" name="active" ${p.active ? raw('checked') : ''}> 신고 받기</span></label>
          ${p.rejections.map((x) => html`<div class="reject"><span>막힌 주소 <code>${x.origin}</code> · ${x.count}번 · ${fmtRel(x.last_at)}</span>
            ${x.origin !== '(없음)' ? html`<button type="button" class="btn small" data-act="allow" data-origin="${x.origin}">허용에 추가</button>` : html`<button type="button" class="btn small" data-act="allow" data-origin="native">native 허용</button>`}</div>`)}
          <div class="actions"><button class="btn primary">저장</button></div>
          <details><summary>게임에 붙이는 코드</summary><pre class="snippet">${snippet(p)}</pre>
            <button type="button" class="btn small" data-act="copy-snippet">코드 복사</button></details>
        </div>
      </form>`)}
    <form class="card form" id="newProj">
      <h3>새 게임 추가</h3>
      <div class="two">
        <label>id (영어 소문자·숫자·-)<input type="text" name="id" required pattern="[a-z0-9][a-z0-9-]{1,39}" placeholder="my-game"></label>
        <label>이름<input type="text" name="name" required maxlength="80" placeholder="내 게임"></label>
      </div>
      <label>플랫폼<select name="platform">${Object.entries(PLATFORM).map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></label>
      <label>허용 주소 (한 줄에 하나, 비워 두면 막힌 주소를 보고 추가)<textarea name="origins" rows="2"></textarea></label>
      <div class="actions"><button class="btn primary">추가</button></div>
    </form>`);

  page.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const origins = String(f.get('origins') || '').split(/\s+/).filter(Boolean);
    try {
      if (e.target.id === 'newProj') {
        await api('/projects', { method: 'POST', body: JSON.stringify({ id: f.get('id'), name: f.get('name'), platform: f.get('platform'), allowed_origins: origins }) });
      } else {
        await api('/projects/' + e.target.dataset.proj, { method: 'PATCH', body: JSON.stringify({ name: f.get('name'), platform: f.get('platform'), allowed_origins: origins, active: !!f.get('active') }) });
      }
      toast('저장했어요');
      renderProjects();
    } catch (err) { fail(err); }
  });
}

function snippet(p) {
  const o = location.origin;
  return `<script src="${o}/sdk/qa-report.js"></script>
<script>
  QAReport.init({
    endpoint: '${o}',
    project: '${p.id}',
    platform: '${p.platform}',
    version: '0.1.0',        // 게임 버전
    channel: 'test',         // 운영판은 'prod'
    getContext: () => ({ /* 장면, 단계 등 */ }),
    onPause: () => { /* 게임·소리 멈춤 */ },
    onResume: () => { /* 다시 시작 */ },
  });
  // 게임 곳곳에: QAReport.note('누름', '점프'); QAReport.note('단계', '2-1 시작');
</script>`;
}

async function refreshProjects() {
  try { S.projects = (await api('/projects')).projects; } catch (e) { fail(e); }
}

// ───────────── 전역 클릭 ─────────────
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const r = S.current;
  if (act === 'logout') logout();
  else if (act === 'more') loadList(true);
  else if (act === 'back') location.hash = '#/';
  else if (act === 'copy-claude' && r) copy(claudeFixPrompt(r));
  else if (act === 'copy-reply' && r) copy(claudeReplyPrompt(r));
  else if (act === 'copy-triage') copy(claudeTriagePrompt(S.list));
  else if (act === 'copy-snippet') copy(b.closest('details').querySelector('pre').textContent);
  else if (act === 'zoom' && S.shotUrl) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = '<img alt="">';
    lb.firstChild.src = S.shotUrl;
    lb.addEventListener('click', () => lb.remove());
    document.body.appendChild(lb);
  } else if (act === 'delete' && r) {
    if (!confirm(`#${r.id} 신고를 지울까요? 사진과 기록도 함께 지워지고 되돌릴 수 없어요.\n(스팸이 아니라면 '보류'로 두는 편이 기록이 남아 좋아요.)`)) return;
    try {
      await api('/reports/' + r.id, { method: 'DELETE' });
      S.list = S.list.filter((x) => x.id !== r.id);
      S.current = null;
      toast('지웠어요');
      location.hash = '#/';
      loadStats();
    } catch (err) { fail(err); }
  } else if (act === 'allow') {
    const ta = b.closest('form').querySelector('textarea[name=origins]');
    ta.value = (ta.value.trim() + '\n' + b.dataset.origin).trim();
    b.closest('form').requestSubmit();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 'projectSel') return;
  S.project = e.target.value;
  localStorage.setItem('qa-admin-project', S.project);
  loadStats();
  if (currentTab() === 'ops') return renderOps();
  if (currentTab() !== 'reports') return;
  loadList();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { const lb = $('.lightbox'); if (lb) lb.remove(); }
});

function currentTab() {
  const h = location.hash;
  return h.startsWith('#/projects') ? 'projects' : h.startsWith('#/ops') ? 'ops' : 'reports';
}

// ───────────── 길 찾기 ─────────────
async function route() {
  if (!S.key) return renderLogin();
  const h = location.hash || '#/';
  stopOpsTimer();
  if (h.startsWith('#/projects')) return renderProjects();
  if (h.startsWith('#/ops')) return renderOps();
  if (!$('#layout')) {
    renderReportsShell();
    await loadList();
  }
  const m = /^#\/r\/(\d+)/.exec(h);
  if (m) openReport(Number(m[1]));
  else {
    S.current = null;
    $('#layout').classList.remove('has-detail');
    mount($('#detail'), html`<p class="empty">왼쪽에서 신고를 고르세요.</p>`);
    renderItems();
  }
}

async function start() {
  await refreshProjects();
  if (S.project && !S.projects.some((p) => p.id === S.project)) S.project = '';
  await loadStats();
  $('#app').innerHTML = '';
  route();
}

window.addEventListener('hashchange', () => {
  // 프로젝트 화면에서 신고 화면으로 돌아오면 다시 그림
  if (currentTab() === 'reports' && !$('#layout')) $('#app').innerHTML = '';
  route();
});

if (S.key) {
  api('/me').then(start, () => renderLogin());
} else {
  renderLogin();
}
