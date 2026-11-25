'use strict';
/* 관리자 페이지 「관제」 탭 — admin.js 의 html``, api(), S 등을 함께 씁니다. */

const EVENT = {
  'report.accepted': '받은 신고',
  'report.rejected_origin': '막힌 주소',
  'report.rate_limited': '한도 초과',
  'report.invalid': '잘못된 신고',
  'report.too_large': '너무 큰 사진',
  'report.unknown_project': '없는 게임',
  'server.error': '서버 오류',
  'r2.error': '사진 저장 오류',
  'notify.error': '알림 실패',
  'admin.auth_failed': '관리자 열쇠 실패',
};
// 문제로 보는 사건 (두 번째 그래프)
const PROBLEM = ['report.rejected_origin', 'report.rate_limited', 'report.invalid', 'report.too_large', 'report.unknown_project', 'server.error', 'r2.error', 'notify.error', 'admin.auth_failed'];
const D1_FREE = 500 * 1024 * 1024; // 무료 요금제 데이터베이스 하나 한도
const R2_FREE = 10 * 1024 * 1024 * 1024; // 무료 저장 용량

const OPS = { hours: Number(localStorage.getItem('qa-ops-hours')) || 24, auto: localStorage.getItem('qa-ops-auto') !== '0', timer: null, data: null };

function stopOpsTimer() {
  if (OPS.timer) clearInterval(OPS.timer);
  OPS.timer = null;
}

function fmtBytes(b) {
  if (b == null) return '-';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + 'KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}

async function renderOps() {
  if (!$('#ops')) {
    mount($('#app'), html`${topBar('ops')}<main class="page wide" id="ops"><p class="empty">불러오는 중…</p></main>`);
  }
  try {
    const p = new URLSearchParams({ hours: OPS.hours });
    if (S.project) p.set('project', S.project);
    OPS.data = await api('/ops?' + p);
    drawOps();
  } catch (e) {
    mount($('#ops'), html`<p class="empty">관제 정보를 불러오지 못했어요: ${e.message}</p>`);
  }
  stopOpsTimer();
  if (OPS.auto) OPS.timer = setInterval(() => { if (currentTab() === 'ops' && !document.hidden) renderOps(); }, 60000);
}

function statusTile(ok, label, detail) {
  return html`<div class="tile ${ok === true ? 'good' : ok === false ? 'bad' : ''}">
    <div class="tile-label">${label}</div>
    <div class="tile-value">${ok === true ? '✅ 정상' : ok === false ? '⚠️ 이상' : '—'}</div>
    <div class="tile-sub">${detail}</div></div>`;
}

function drawOps() {
  const d = OPS.data;
  const h = d.health;
  const t = d.totals;
  const sum = (keys) => keys.reduce((a, k) => a + (t[k] || 0), 0);
  const ver = h.version;
  const cronAt = d.cron && d.cron.at;
  const cronLate = cronAt && Date.now() - cronAt > 2 * 3600000;

  // 시간별 묶음: 하루는 1시간, 사흘은 3시간, 그 이상은 6시간
  const step = d.hours <= 24 ? 1 : d.hours <= 72 ? 3 : 6;
  const buckets = [];
  for (let hr = d.from_hour; hr <= d.now_hour; hr += step) buckets.push({ hour: hr, accepted: 0, problems: 0 });
  for (const c of d.counters) {
    const b = buckets[Math.floor((c.hour - d.from_hour) / step)];
    if (!b) continue;
    if (c.event === 'report.accepted') b.accepted += c.n;
    else if (PROBLEM.includes(c.event)) b.problems += c.n;
  }

  const problemTotal = sum(PROBLEM);
  const serverErr = sum(['server.error', 'r2.error']);

  mount($('#ops'), html`
    <div class="ops-bar">
      <div class="seg" id="opsHours">
        ${[[24, '24시간'], [72, '3일'], [168, '7일']].map(([v, l]) => html`<button type="button" data-hours="${v}" aria-pressed="${OPS.hours === v}">${l}</button>`)}
      </div>
      <label class="sub"><input type="checkbox" id="opsAuto" ${OPS.auto ? raw('checked') : ''}> 1분마다 새로 고침</label>
      <span class="sub">마지막 확인 ${fmtTime(Date.now()).slice(11)}</span>
      <button class="btn small" data-act="ops-refresh">지금 새로 고침</button>
    </div>

    <section class="tiles">
      ${statusTile(h.ok, '서버 (D1 · R2)', `D1 ${h.db.ok ? h.db.ms + 'ms' : '이상: ' + (h.db.error || '')} · R2 ${h.r2.ok ? h.r2.ms + 'ms' : '이상: ' + (h.r2.error || '')}`)}
      <div class="tile"><div class="tile-label">지금 배포된 판</div>
        <div class="tile-value mono">${ver ? ver.tag || ver.id.slice(0, 8) : '로컬 개발'}</div>
        <div class="tile-sub">${ver && ver.deployed_at ? fmtTime(Date.parse(ver.deployed_at)) + ' 배포' : 'wrangler dev 에서는 버전 정보가 없어요'}</div></div>
      <div class="tile"><div class="tile-label">마지막 신고</div>
        <div class="tile-value">${d.last_report_at ? fmtRel(d.last_report_at) : '없음'}</div>
        <div class="tile-sub">${d.last_report_at ? fmtTime(d.last_report_at) : '아직 받은 신고가 없어요'}</div></div>
      ${statusTile(cronAt ? (cronLate ? false : d.cron.value.ok) : null, '매시 정기 점검',
        cronAt ? `${fmtRel(cronAt)}${cronLate ? ' — 2시간 넘게 안 돌았어요' : ''} · ${d.cron.value.ms}ms` : '아직 한 번도 안 돌았어요 (배포 후 정각에 시작)')}
      <div class="tile ${d.alerts.discord ? 'good' : ''}"><div class="tile-label">디스코드 알림</div>
        <div class="tile-value">${d.alerts.discord ? '🔔 연결됨' : '🔕 꺼짐'}</div>
        <div class="tile-sub">${d.alerts.discord
          ? html`<button class="btn small" data-act="ops-test-alert">시험 알림 보내기</button>${d.daily ? html` · 하루 요약 ${fmtRel(d.daily.at)}` : ''}`
          : html`<code>wrangler secret put DISCORD_WEBHOOK_URL</code>`}</div></div>
    </section>

    <section class="nums">
      ${num('받은 신고', t['report.accepted'] || 0, false)}
      ${num('막힌 주소', t['report.rejected_origin'] || 0, true, '#/projects')}
      ${num('한도 초과', t['report.rate_limited'] || 0, true)}
      ${num('잘못된 신고', sum(['report.invalid', 'report.too_large', 'report.unknown_project']), true)}
      ${num('서버 오류', serverErr, true)}
      ${num('알림 실패', t['notify.error'] || 0, true)}
      ${num('관리자 열쇠 실패', t['admin.auth_failed'] || 0, true)}
    </section>

    <div class="ops-grid">
      <div class="card">
        <h3>${step === 1 ? '시간별' : step + '시간별'} 받은 신고</h3>
        ${barChart(buckets, 'accepted', step, 'accent')}
      </div>
      <div class="card">
        <h3>${step === 1 ? '시간별' : step + '시간별'} 문제 요청 <span class="sub">(막힌 주소 · 한도 초과 · 잘못된 신고 · 서버 오류 · 알림 실패 · 열쇠 실패)</span></h3>
        ${problemTotal ? barChart(buckets, 'problems', step, 'warn') : html`<p class="sub ops-empty">이 기간에 문제 요청이 없어요 👍</p>`}
      </div>
    </div>

    <div class="ops-grid">
      <div class="card">
        <h3>최근 서버 오류</h3>
        ${d.errors.length
          ? html`<table class="tbl"><thead><tr><th>때</th><th>위치</th><th>내용</th><th>Ray ID</th></tr></thead><tbody>
              ${d.errors.map((e) => html`<tr><td class="nowrap" title="${fmtTime(e.at)}">${fmtRel(e.at)}</td><td><code>${e.source}</code></td><td class="msgcell">${e.message}</td>
                <td>${e.ray ? html`<button class="btn small mono" data-act="copy-text" data-text="${e.ray}" title="복사해서 Cloudflare 로그에서 찾기">${e.ray.slice(0, 10)}…</button>` : '-'}</td></tr>`)}
            </tbody></table>`
          : html`<p class="sub">이 기간에 서버 오류가 없어요.</p>`}
      </div>
      <div class="card">
        <h3>저장 공간 <span class="sub">(무료 요금제 기준)</span></h3>
        ${meter('D1 데이터베이스', d.storage.db_bytes, D1_FREE)}
        ${meter('R2 화면 사진', d.storage.shot_bytes, R2_FREE)}
        <dl class="kv">
          <dt>신고</dt><dd>${d.storage.reports}건 (사진 ${d.storage.shots}장)</dd>
          <dt>처리 기록</dt><dd>${d.storage.events}줄</dd>
          <dt>막힌 주소</dt><dd>${d.rejections && d.rejections.n ? html`${d.rejections.n}곳 · <a href="#/projects">게임 · 연결에서 보기</a>` : '없음'}</dd>
        </dl>
      </div>
    </div>

    <div class="ops-grid">
      <div class="card">
        <h3>사건별 수 (${OPS.hours === 24 ? '24시간' : OPS.hours / 24 + '일'})</h3>
        <table class="tbl"><thead><tr><th>사건</th><th class="num">수</th></tr></thead><tbody>
          ${Object.keys(EVENT).map((k) => html`<tr><td>${EVENT[k]} <code class="sub">${k}</code></td><td class="num">${t[k] || 0}</td></tr>`)}
        </tbody></table>
      </div>
      <div class="card">
        <h3>더 자세히 보기</h3>
        <ul class="links">
          <li><a href="https://dash.cloudflare.com/?to=/:account/workers-and-pages" target="_blank" rel="noopener noreferrer">Cloudflare 대시보드</a>
            → <b>qatool</b> → <b>Observability</b>: 모든 요청 로그. <code>event</code>, <code>route</code>, <code>status</code>, <code>ray</code> 로 거르기.</li>
          <li>Ray ID 로 찾기: 위 오류 표에서 Ray ID 를 복사해 로그 검색 칸에 붙여 넣기.</li>
          <li>터미널에서 실시간으로: <code>npm run logs</code> (전부) · <code>npm run logs:errors</code> (오류만)</li>
          <li>바깥 감시: <code>${location.origin}/api/health</code> 를 UptimeRobot 같은 무료 감시에 등록 — 이상하면 503.</li>
        </ul>
      </div>
    </div>`);

  $('#opsHours').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    OPS.hours = Number(b.dataset.hours);
    localStorage.setItem('qa-ops-hours', OPS.hours);
    renderOps();
  });
  $('#opsAuto').addEventListener('change', (e) => {
    OPS.auto = e.target.checked;
    localStorage.setItem('qa-ops-auto', OPS.auto ? '1' : '0');
    renderOps();
  });
  bindChartHover();
}

function num(label, n, isProblem, href) {
  const bad = isProblem && n > 0;
  const body = html`<div class="num-label">${label}</div><div class="num-value">${bad ? '⚠️ ' : ''}${n}</div>`;
  return href && bad ? html`<a class="numtile bad" href="${href}">${body}</a>` : html`<div class="numtile ${bad ? 'bad' : ''}">${body}</div>`;
}

function meter(label, used, limit) {
  const pct = used == null ? null : Math.min(100, (used / limit) * 100);
  const level = pct == null ? '' : pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  return html`<div class="meter ${level}">
    <div class="meter-head"><span>${label}</span><span>${fmtBytes(used)} / ${fmtBytes(limit)}${pct != null ? ` (${pct < 0.1 && used > 0 ? '<0.1' : pct.toFixed(1)}%)` : ''}</span></div>
    <div class="meter-track"><div class="meter-fill" style="width:${pct == null ? 0 : Math.max(pct, used > 0 ? 0.5 : 0)}%"></div></div></div>`;
}

function bucketLabel(hour, step, long) {
  const d = new Date(hour * 3600000);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const hh = `${d.getHours()}시`;
  if (long) return step === 1 ? `${md} ${hh}` : `${md} ${hh}부터 ${step}시간`;
  return d.getHours() < step ? md : hh;
}

/** 막대 하나 = 한 묶음. 위쪽만 4px 둥글게, 막대 사이 2px, 각 막대 전체 높이가 마우스 영역 */
function barChart(buckets, key, step, tone) {
  const W = 640, H = 170, padL = 30, padB = 22, padT = 8;
  const n = buckets.length;
  const max = Math.max(1, ...buckets.map((b) => b[key]));
  const nice = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const plotW = W - padL, plotH = H - padB - padT;
  const slot = plotW / n;
  const bw = Math.max(1, slot - 2);
  const y = (v) => padT + plotH - (v / nice) * plotH;
  const ticks = nice <= 4 ? [...Array(nice + 1).keys()] : [0, nice / 4, nice / 2, (nice * 3) / 4, nice];
  const labelEvery = Math.ceil(n / 8);

  const bars = buckets.map((b, i) => {
    const v = b[key];
    const x = padL + i * slot + 1;
    const top = y(v);
    const hgt = padT + plotH - top;
    const r = Math.min(4, hgt, bw / 2);
    const path = v > 0
      ? `M${x},${padT + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${padT + plotH} Z`
      : '';
    return html`<g class="bar" data-tip="${bucketLabel(b.hour, step, true)} · ${v}건">
      <rect class="hit" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}"></rect>
      ${path ? html`<path class="mark ${tone}" d="${path}"></path>` : ''}
      ${i % labelEvery === 0 ? html`<text class="xl" x="${x + bw / 2}" y="${H - 6}">${bucketLabel(b.hour, step, false)}</text>` : ''}
    </g>`;
  });

  return html`<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="막대 그래프, 가장 많을 때 ${max}건">
      ${ticks.map((tv) => html`<g><line class="grid" x1="${padL}" x2="${W}" y1="${y(tv)}" y2="${y(tv)}"></line><text class="yl" x="${padL - 6}" y="${y(tv) + 4}">${Math.round(tv)}</text></g>`)}
      ${bars}
    </svg>
    <div class="tip" hidden></div>
  </div>`;
}

function bindChartHover() {
  for (const chart of document.querySelectorAll('.chart')) {
    const tip = chart.querySelector('.tip');
    chart.addEventListener('mousemove', (e) => {
      const g = e.target.closest('.bar');
      chart.querySelectorAll('.bar.on').forEach((x) => x !== g && x.classList.remove('on'));
      if (!g) { tip.hidden = true; return; }
      g.classList.add('on');
      tip.textContent = g.dataset.tip;
      tip.hidden = false;
      const box = chart.getBoundingClientRect();
      const x = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 4);
      tip.style.left = Math.max(0, x) + 'px';
      tip.style.top = Math.max(0, e.clientY - box.top - 34) + 'px';
    });
    chart.addEventListener('mouseleave', () => {
      tip.hidden = true;
      chart.querySelectorAll('.bar.on').forEach((x) => x.classList.remove('on'));
    });
  }
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'ops-refresh') renderOps();
  else if (b.dataset.act === 'copy-text') copy(b.dataset.text);
  else if (b.dataset.act === 'ops-test-alert') {
    b.disabled = true;
    try {
      await api('/ops/test-alert', { method: 'POST', body: '{}' });
      toast('디스코드로 시험 알림을 보냈어요');
    } catch (err) { fail(err); }
    b.disabled = false;
  }
});
