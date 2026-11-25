/*!
 * QAReport SDK — 게임 안 「신고」 단추 + 최근 3분 기록
 *
 *   <script src="https://<내 신고함 주소>/sdk/qa-report.js"></script>
 *   QAReport.init({ endpoint: 'https://<내 신고함 주소>', project: 'my-game', version: '0.1.0', channel: 'test' });
 *   QAReport.note('단계', '2-1 시작');   // 게임 곳곳에
 *
 * 3분 기록은 메모리에만 들고 있다가 신고할 때만 함께 보냅니다. 이름·연락처는 보내지 않습니다.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.QAReport = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var TEXT = {
    ko: {
      button: '📣 신고',
      title: '무엇을 알려 주실래요?',
      kinds: {
        bug: ['🐞', '오류', '멈춤, 안 눌림, 못 지나감'],
        stuck: ['🧭', '막힘', '무엇을 해야 할지 모르겠어요'],
        art_sound: ['🎨', '그림·소리', '겹침, 잘림, 거슬리는 소리'],
        fun: ['😀', '재미', '이 부분 어땠나요?'],
        suggestion: ['💬', '제안', '이렇게 되면 좋겠어요'],
        other: ['✏️', '그 밖', '하고 싶은 말'],
      },
      ratings: { good: '재미있었다', meh: '그저 그렇다', bad: '지루했다' },
      placeholder: '무슨 일이 있었나요? 한 줄이면 충분해요.',
      mic: '🎤 말로 적기',
      micOn: '● 듣는 중… (다시 누르면 멈춤)',
      withShot: '화면 사진 같이 보내기',
      disclose: '함께 가는 것: 화면 사진 · 최근 3분 기록({n}개) · 기기 정보 · 게임 버전. 이름이나 연락처는 보내지 않아요.',
      cancel: '취소',
      send: '보내기',
      sending: '보내는 중…',
      sent: '보냈어요. 고마워요! (#{id})',
      queued: '인터넷이 불안해서 저장해 뒀어요. 다음에 켜면 다시 보낼게요.',
      needText: '한 줄만 적어 주세요.',
      badge: '테스트판',
    },
    en: {
      button: '📣 Report',
      title: 'What would you like to tell us?',
      kinds: {
        bug: ['🐞', 'Bug', 'Freeze, button not working, can’t proceed'],
        stuck: ['🧭', 'Stuck', 'I don’t know what to do'],
        art_sound: ['🎨', 'Art / Sound', 'Overlaps, clipping, annoying sound'],
        fun: ['😀', 'Fun', 'How was this part?'],
        suggestion: ['💬', 'Idea', 'It would be nice if…'],
        other: ['✏️', 'Other', 'Anything else'],
      },
      ratings: { good: 'Fun', meh: 'So-so', bad: 'Boring' },
      placeholder: 'What happened? One line is enough.',
      mic: '🎤 Speak',
      micOn: '● Listening… (tap to stop)',
      withShot: 'Include screenshot',
      disclose: 'Sent with this: screenshot · last 3 min log ({n} items) · device info · game version. No name or contact info.',
      cancel: 'Cancel',
      send: 'Send',
      sending: 'Sending…',
      sent: 'Sent. Thank you! (#{id})',
      queued: 'Connection is unstable — saved, will retry next time.',
      needText: 'Please write at least one line.',
      badge: 'TEST',
    },
  };

  var DEFAULT_KINDS = ['bug', 'stuck', 'art_sound', 'fun', 'suggestion', 'other'];
  var RATED = { fun: true };
  var MAX_SHOT = 650 * 1024; // 서버 한도(700KB)보다 조금 작게
  var QUEUE_MAX = 3;

  var opts = null;
  var t = TEXT.ko;
  var log = [];
  var startedAt = Date.now();
  var isOpen = false;
  var host = null;
  var badgeEl = null;
  var buttonEl = null;
  var origConsoleError = null;

  // ───────────── 최근 기록 ─────────────

  function prune(now) {
    var keep = (opts && opts.keepMs) || 3 * 60 * 1000;
    while (log.length && log[0].t < now - keep) log.shift();
    if (log.length > 500) log.splice(0, log.length - 500);
  }

  function note(kind, text) {
    var now = Date.now();
    text = String(text == null ? '' : text).slice(0, 500);
    kind = String(kind || 'note').slice(0, 24);
    var last = log[log.length - 1];
    if (last && last.kind === kind && last.text === text) {
      last.n++;
      last.t = now;
    } else {
      log.push({ t: now, kind: kind, text: text, n: 1 });
    }
    prune(now);
  }

  function errorText(x) {
    if (!x) return String(x);
    if (x instanceof Error) return (x.name || 'Error') + ': ' + x.message + (x.stack ? '\n' + String(x.stack).split('\n').slice(1, 4).join('\n') : '');
    if (typeof x === 'object') {
      try { return JSON.stringify(x).slice(0, 300); } catch (e) { return String(x); }
    }
    return String(x);
  }

  function hookErrors() {
    window.addEventListener('error', function (e) {
      // 리소스(이미지 등) 로드 실패
      if (e && e.target && e.target !== window && (e.target.src || e.target.href)) {
        note('error', 'load failed: ' + (e.target.src || e.target.href));
        return;
      }
      var file = String(e.filename || '').split('?')[0];
      file = file.slice(file.lastIndexOf('/', file.length - 2) + 1);
      var where = file ? ' (' + file + ':' + e.lineno + ')' : '';
      note('error', (e.error ? errorText(e.error) : e.message) + where);
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      note('error', 'Unhandled promise: ' + errorText(e.reason));
    });
    if (opts.captureConsoleError !== false && window.console && console.error) {
      origConsoleError = console.error;
      console.error = function () {
        try {
          note('error', Array.prototype.map.call(arguments, errorText).join(' '));
        } catch (e) { /* 기록 실패는 무시 */ }
        return origConsoleError.apply(console, arguments);
      };
    }
    document.addEventListener('visibilitychange', function () {
      note('app', document.hidden ? 'hidden' : 'visible');
    });
  }

  function hasRecentError() {
    prune(Date.now());
    for (var i = 0; i < log.length; i++) if (log[i].kind === 'error') return true;
    return false;
  }

  function trailForSend() {
    var now = Date.now();
    prune(now);
    return log.map(function (e) { return { ago: now - e.t, kind: e.kind, text: e.text, n: e.n }; });
  }

  // ───────────── 화면 사진 ─────────────

  function findCanvas() {
    var c = opts.canvas;
    if (typeof c === 'function') c = c();
    if (typeof c === 'string') c = document.querySelector(c);
    if (c && c.tagName === 'CANVAS') return c;
    var best = null, area = 0;
    var all = document.getElementsByTagName('canvas');
    for (var i = 0; i < all.length; i++) {
      var a = all[i].width * all[i].height;
      if (a > area) { area = a; best = all[i]; }
    }
    return best;
  }

  function shrink(canvas) {
    var maxEdge = opts.shotMaxEdge || 1280;
    var w = canvas.width, h = canvas.height;
    if (!w || !h) return null;
    var s = Math.min(1, maxEdge / Math.max(w, h));
    var out = document.createElement('canvas');
    out.width = Math.round(w * s);
    out.height = Math.round(h * s);
    var ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    var q = 0.75, url = out.toDataURL('image/jpeg', q);
    while (url.length * 0.75 > MAX_SHOT && q > 0.3) {
      q -= 0.15;
      url = out.toDataURL('image/jpeg', q);
    }
    return url.length * 0.75 > MAX_SHOT ? null : url;
  }

  function captureShot() {
    return Promise.resolve()
      .then(function () {
        if (opts.captureScreenshot) return opts.captureScreenshot();
        var c = findCanvas();
        return c ? c : null;
      })
      .then(function (x) {
        if (!x) return null;
        if (typeof x === 'string') {
          // 게임이 직접 준 data URL — 너무 크면 줄임
          if (x.length * 0.75 <= MAX_SHOT) return x;
          return new Promise(function (res) {
            var img = new Image();
            img.onload = function () {
              var c = document.createElement('canvas');
              c.width = img.naturalWidth; c.height = img.naturalHeight;
              c.getContext('2d').drawImage(img, 0, 0);
              res(shrink(c));
            };
            img.onerror = function () { res(null); };
            img.src = x;
          });
        }
        return shrink(x);
      })
      .catch(function (e) {
        note('qa', 'screenshot failed: ' + errorText(e));
        return null;
      });
  }

  // ───────────── 보내기 ─────────────

  function envInfo() {
    var coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    return {
      screen: screen.width + 'x' + screen.height,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      orientation: window.innerWidth > window.innerHeight ? 'landscape' : 'portrait',
      input: coarse || navigator.maxTouchPoints > 0 ? 'touch' : 'mouse',
      ua: navigator.userAgent.slice(0, 300),
      lang: navigator.language,
      url: location.origin + location.pathname,
    };
  }

  function contextInfo() {
    var ctx = {};
    try { if (opts.getContext) ctx = opts.getContext() || {}; } catch (e) { ctx = { contextError: errorText(e) }; }
    ctx.playSec = Math.round((Date.now() - startedAt) / 1000);
    if (opts.build) ctx.build = opts.build;
    return ctx;
  }

  function post(payload) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl && setTimeout(function () { ctrl.abort(); }, 20000);
    return fetch(opts.endpoint.replace(/\/+$/, '') + '/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) {
          var err = new Error(body.error || 'HTTP ' + r.status);
          err.status = r.status;
          throw err;
        }
        return body;
      });
    }, function (e) {
      if (timer) clearTimeout(timer);
      e.network = true;
      throw e;
    });
  }

  function queueKey() { return 'qa-report-queue:' + opts.project; }

  function enqueue(payload) {
    try {
      var q = JSON.parse(localStorage.getItem(queueKey()) || '[]');
      q.push(payload);
      q = q.slice(-QUEUE_MAX);
      try {
        localStorage.setItem(queueKey(), JSON.stringify(q));
      } catch (e) {
        // 저장 공간이 모자라면 사진을 빼고
        q.forEach(function (p) { delete p.shot; });
        localStorage.setItem(queueKey(), JSON.stringify(q));
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function flushQueue() {
    var q;
    try { q = JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch (e) { return; }
    if (!q.length) return;
    localStorage.removeItem(queueKey());
    q.reduce(function (p, item) {
      return p.then(function () {
        return post(item).catch(function (e) { if (e.network) enqueue(item); });
      });
    }, Promise.resolve());
  }

  /** 화면 없이 바로 보내기 (예: 게임이 스스로 감지한 문제) */
  function send(r) {
    if (!opts) return Promise.reject(new Error('QAReport.init() 을 먼저 불러 주세요'));
    var payload = {
      project: opts.project,
      kind: r.kind || 'other',
      rating: r.rating || undefined,
      message: r.message || '',
      version: opts.version,
      channel: opts.channel,
      platform: opts.platform,
      context: Object.assign(contextInfo(), r.context || {}),
      env: envInfo(),
      trail: trailForSend(),
      shot: r.shot || undefined,
    };
    return post(payload).catch(function (e) {
      if (e.network && enqueue(payload)) {
        e.queued = true;
      }
      throw e;
    });
  }

  // ───────────── 화면 (Shadow DOM 으로 게임 CSS 와 분리) ─────────────

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}',
    '.back{position:fixed;inset:0;background:rgba(10,12,20,.55);display:flex;align-items:center;justify-content:center;padding:max(8px,env(safe-area-inset-top)) 8px max(8px,env(safe-area-inset-bottom));z-index:2147483000;-webkit-tap-highlight-color:transparent}',
    '.box{background:#fff;color:#1b1f2a;border-radius:16px;width:min(560px,100%);max-height:100%;overflow:auto;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);display:grid;gap:12px}',
    'h2{margin:0;font-size:17px;font-weight:700}',
    '.kinds{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}',
    '.kind,.rate{border:1.5px solid #d9dde6;background:#f7f8fb;border-radius:10px;padding:8px 4px;font-size:14px;cursor:pointer;color:inherit;text-align:center;line-height:1.2}',
    '.kind b{display:block;font-size:20px;font-weight:400;margin-bottom:2px}',
    '.kind[aria-pressed=true],.rate[aria-pressed=true]{border-color:#3866f2;background:#eaf0ff;color:#1d3fb8;font-weight:600}',
    '.rates{display:flex;gap:6px}.rate{flex:1;padding:8px}',
    'textarea{width:100%;min-height:72px;resize:vertical;border:1.5px solid #d9dde6;border-radius:10px;padding:10px;font-size:15px;color:inherit;background:#fff}',
    'textarea:focus{outline:2px solid #3866f2;border-color:transparent}',
    '.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.mic{border:1.5px solid #d9dde6;background:#fff;border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer;color:inherit}',
    '.mic.on{border-color:#e5484d;color:#e5484d}',
    '.shot{display:flex;gap:10px;align-items:center;font-size:13px}',
    '.shot img{width:96px;max-height:64px;object-fit:contain;border-radius:6px;background:#000;border:1px solid #d9dde6}',
    '.shot label{display:flex;gap:6px;align-items:center;cursor:pointer}',
    '.note{font-size:12px;color:#5c6475;margin:0;line-height:1.45}',
    '.msg{font-size:13px;min-height:1em;margin:0;color:#c4282d}.msg.ok{color:#1a7f4b}',
    '.acts{display:flex;gap:8px;justify-content:flex-end}',
    '.acts button{border:0;border-radius:10px;padding:10px 18px;font-size:15px;cursor:pointer;font-weight:600}',
    '.cancel{background:#eef0f4;color:#1b1f2a}.go{background:#3866f2;color:#fff}.go:disabled{opacity:.6;cursor:default}',
    // 휴대폰 가로 화면: 두 칸으로
    '@media (orientation:landscape) and (max-height:520px){.box{width:min(820px,100%);grid-template-columns:1fr 1fr;padding:12px;gap:10px}h2,.note,.msg,.acts{grid-column:1/-1}.kinds{grid-template-columns:repeat(3,1fr)}.kind{padding:5px 2px;font-size:13px}.kind b{font-size:17px}textarea{min-height:60px}}',
    '@media (prefers-color-scheme:dark){.box{background:#1d212b;color:#e8eaf0}.kind,.rate{background:#262b37;border-color:#394052}.kind[aria-pressed=true],.rate[aria-pressed=true]{background:#24346b;color:#cfdcff;border-color:#6d8cff}textarea,.mic{background:#151820;border-color:#394052;color:#e8eaf0}.cancel{background:#2c3240;color:#e8eaf0}.note{color:#9aa2b4}}',
  ].join('');

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') for (var ev in attrs.on) e.addEventListener(ev, attrs.on[ev]);
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function stopBubbling(node) {
    // 창이 떠 있는 동안 키보드·터치가 게임으로 새지 않게
    ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchend', 'touchmove', 'mousedown', 'mouseup', 'click', 'wheel'].forEach(function (ev) {
      node.addEventListener(ev, function (e) { e.stopPropagation(); }, false);
    });
  }

  function open(preset) {
    if (!opts) throw new Error('QAReport.init() 을 먼저 불러 주세요');
    if (isOpen) return;
    isOpen = true;
    preset = preset || {};
    note('qa', 'report opened');
    try { if (opts.onPause) opts.onPause(); } catch (e) { note('error', 'onPause: ' + errorText(e)); }

    captureShot().then(function (shot) { render(shot, preset); });
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    if (host) { host.remove(); host = null; }
    try { if (opts.onResume) opts.onResume(); } catch (e) { note('error', 'onResume: ' + errorText(e)); }
  }

  function render(shot, preset) {
    host = el('div', { 'data-qa-report': '' });
    stopBubbling(host);
    var rootEl = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    rootEl.appendChild(el('style', { text: CSS }));

    var kinds = (opts.kinds || DEFAULT_KINDS).map(function (k) {
      if (typeof k === 'string') {
        var d = t.kinds[k] || ['•', k, ''];
        return { id: k, emoji: d[0], label: d[1], hint: d[2], rated: !!RATED[k] };
      }
      return k;
    });
    var state = {
      kind: preset.kind || (hasRecentError() && kinds.some(function (k) { return k.id === 'bug'; }) ? 'bug' : null),
      rating: null,
      withShot: !!shot,
    };

    var msg = el('p', { class: 'msg', role: 'status' });
    var ta = el('textarea', { placeholder: t.placeholder, maxlength: '4000', 'aria-label': t.placeholder });
    if (preset.message) ta.value = preset.message;
    var rateRow = el('div', { class: 'rates' });
    var kindBtns = [];

    function sync() {
      kindBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.id === state.kind)); });
      var k = kinds.filter(function (x) { return x.id === state.kind; })[0];
      rateRow.style.display = k && k.rated ? 'flex' : 'none';
      ta.placeholder = k && k.hint ? k.hint + ' — ' + t.placeholder : t.placeholder;
      Array.prototype.forEach.call(rateRow.children, function (b) { b.setAttribute('aria-pressed', String(b.dataset.id === state.rating)); });
    }

    kinds.forEach(function (k) {
      var b = el('button', { class: 'kind', type: 'button', 'data-id': k.id, title: k.hint || '' }, [el('b', { text: k.emoji }), document.createTextNode(k.label)]);
      b.addEventListener('click', function () { state.kind = k.id; if (!k.rated) state.rating = null; msg.textContent = ''; sync(); });
      kindBtns.push(b);
    });
    ['good', 'meh', 'bad'].forEach(function (r) {
      var b = el('button', { class: 'rate', type: 'button', 'data-id': r, text: t.ratings[r] });
      b.addEventListener('click', function () { state.rating = state.rating === r ? null : r; sync(); });
      rateRow.appendChild(b);
    });

    // 🎤 말로 적기 (지원하는 브라우저에서만)
    var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    var mic = null;
    if (Rec && opts.voice !== false) {
      var rec = null;
      mic = el('button', { class: 'mic', type: 'button', text: t.mic });
      mic.addEventListener('click', function () {
        if (rec) { rec.stop(); return; }
        rec = new Rec();
        rec.lang = opts.lang === 'en' ? 'en-US' : (navigator.language || 'ko-KR');
        rec.interimResults = false;
        rec.onresult = function (e) {
          var said = Array.prototype.map.call(e.results, function (r) { return r[0].transcript; }).join(' ');
          ta.value = (ta.value ? ta.value.replace(/\s*$/, ' ') : '') + said;
        };
        rec.onend = rec.onerror = function () { rec = null; mic.className = 'mic'; mic.textContent = t.mic; };
        mic.className = 'mic on';
        mic.textContent = t.micOn;
        try { rec.start(); } catch (e) { rec.onend(); }
      });
    }

    var shotRow = null;
    if (shot) {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = true;
      cb.addEventListener('change', function () { state.withShot = cb.checked; });
      shotRow = el('div', { class: 'shot' }, [el('img', { src: shot, alt: '' }), el('label', null, [cb, document.createTextNode(t.withShot)])]);
    }

    var goBtn = el('button', { class: 'go', type: 'button', text: t.send });
    var cancelBtn = el('button', { class: 'cancel', type: 'button', text: t.cancel, on: { click: close } });

    goBtn.addEventListener('click', function () {
      var text = ta.value.trim();
      if (!state.kind) { msg.className = 'msg'; msg.textContent = t.title; return; }
      if (!text && !state.rating) { msg.className = 'msg'; msg.textContent = t.needText; ta.focus(); return; }
      goBtn.disabled = true;
      goBtn.textContent = t.sending;
      msg.textContent = '';
      send({ kind: state.kind, rating: state.rating, message: text, shot: state.withShot ? shot : null, context: preset.context })
        .then(function (res) {
          msg.className = 'msg ok';
          msg.textContent = t.sent.replace('{id}', res.id);
          note('qa', 'report sent #' + res.id);
          if (opts.onSent) try { opts.onSent(res); } catch (e) { /* 무시 */ }
          setTimeout(close, 1300);
        })
        .catch(function (e) {
          if (e.queued) {
            msg.className = 'msg ok';
            msg.textContent = t.queued;
            setTimeout(close, 2000);
            return;
          }
          msg.className = 'msg';
          msg.textContent = e.message;
          goBtn.disabled = false;
          goBtn.textContent = t.send;
        });
    });

    var box = el('div', { class: 'box', role: 'dialog', 'aria-modal': 'true', 'aria-label': t.title }, [
      el('h2', { text: t.title }),
      el('div', null, [el('div', { class: 'kinds' }, kindBtns), rateRow]),
      el('div', { style: 'display:grid;gap:8px' }, [ta, mic || shotRow ? el('div', { class: 'row' }, [mic, shotRow]) : null]),
      el('p', { class: 'note', text: t.disclose.replace('{n}', String(log.length)) }),
      msg,
      el('div', { class: 'acts' }, [cancelBtn, goBtn]),
    ]);
    var back = el('div', { class: 'back' }, [box]);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    rootEl.appendChild(back);
    document.body.appendChild(host);
    sync();
    setTimeout(function () { (state.kind ? ta : kindBtns[0]).focus(); }, 50);
  }

  // ───────────── 떠 있는 단추와 판 표시 ─────────────

  function mountChrome() {
    var pos = (opts.button && opts.button.position) || 'bottom-right';
    var v = pos.indexOf('top') === 0 ? 'top' : 'bottom';
    var h = pos.indexOf('left') > 0 ? 'left' : 'right';
    var base = 'position:fixed;z-index:2147482000;font:600 13px system-ui,sans-serif;';
    if (opts.button !== false) {
      buttonEl = el('button', {
        type: 'button',
        'data-qa-report-button': '',
        'aria-label': t.button,
        style: base + v + ':calc(10px + env(safe-area-inset-' + v + '));' + h + ':calc(10px + env(safe-area-inset-' + h + '));' +
          'padding:7px 12px;border-radius:999px;border:0;background:rgba(20,24,36,.72);color:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);',
        text: t.button,
      });
      stopBubbling(buttonEl);
      buttonEl.addEventListener('click', function () { open(); });
      document.body.appendChild(buttonEl);
    }
    var showBadge = opts.badge != null ? opts.badge : opts.channel && opts.channel !== 'prod';
    if (showBadge) {
      var ov = v === 'top' ? 'bottom' : 'top';
      badgeEl = el('div', {
        'data-qa-report-badge': '',
        style: base + ov + ':calc(4px + env(safe-area-inset-' + ov + '));' + h + ':6px;font-weight:500;font-size:11px;padding:2px 6px;border-radius:4px;' +
          'background:rgba(0,0,0,.45);color:#fff;pointer-events:none;',
        text: [t.badge + (opts.channel && opts.channel !== 'test' ? ' (' + opts.channel + ')' : ''), opts.version && 'v' + opts.version, opts.build].filter(Boolean).join(' · '),
      });
      document.body.appendChild(badgeEl);
    }
  }

  // ───────────── 시작 ─────────────

  function init(o) {
    if (opts) return api;
    if (!o || !o.endpoint || !o.project) throw new Error('QAReport.init({ endpoint, project }) 가 필요해요');
    opts = Object.assign({ channel: 'test', platform: 'web' }, o);
    var lang = opts.lang && opts.lang !== 'auto' ? opts.lang : /^ko/i.test(navigator.language || '') ? 'ko' : 'en';
    opts.lang = lang;
    t = Object.assign({}, TEXT[lang] || TEXT.en);
    if (opts.texts) {
      // 일부 문구만 바꿀 수 있게 (kinds 는 섞어서)
      var custom = opts.texts;
      t = Object.assign(t, custom, { kinds: Object.assign({}, t.kinds, custom.kinds || {}) });
    }
    if (opts.ratedKinds) opts.ratedKinds.forEach(function (k) { RATED[k] = true; });
    startedAt = Date.now();
    hookErrors();
    note('app', 'start ' + [opts.channel, opts.version].filter(Boolean).join(' '));
    var ready = function () { mountChrome(); setTimeout(flushQueue, 3000); };
    if (document.body) ready(); else document.addEventListener('DOMContentLoaded', ready);
    return api;
  }

  var api = {
    init: init,
    note: note,
    open: open,
    close: close,
    send: send,
    /** 지금까지의 기록 (디버깅용) */
    getTrail: trailForSend,
    /** 단추 보이기/숨기기 (예: 컷신 동안) */
    setButtonVisible: function (v) { if (buttonEl) buttonEl.style.display = v ? '' : 'none'; },
    version: '0.1.0',
  };
  return api;
});
