# 실제 게임을 QA 신고함에 연결하기

이 문서는 사람과 AI 작업자(ChatGPT, Claude 등)가 함께 봅니다.
**1단계는 사람이**, **2단계는 게임 저장소에서 AI 작업자가**, **3단계는 다시 사람이** 하면 됩니다.

| 항목 | 값 |
|---|---|
| 신고함 주소 (endpoint) | `https://s-qatools.giornogiobana1234.workers.dev` |
| SDK | `https://s-qatools.giornogiobana1234.workers.dev/sdk/qa-report.js` (의존성 없음, 약 26KB) |
| 타입 정의 | 이 저장소의 `public/sdk/qa-report.d.ts` |
| 관리자 페이지 | `https://s-qatools.giornogiobana1234.workers.dev/admin/` → **게임 · 연결** 탭 |

> 게임 쪽에는 **비밀 값이 하나도 필요 없습니다.** `ADMIN_KEY`, `IP_SALT`는 절대 게임 코드·저장소·AI 대화에 넣지 마세요.
> 게임이 아는 것은 신고함 주소와 프로젝트 id뿐이고, 아무 곳에서나 보내지 못하게 막는 일은 서버의 **허용 주소**가 합니다.

---

## 1단계 — 관리자 페이지에서 프로젝트 만들기 (사람)

관리자 페이지 → **게임 · 연결** → 아래 **새 게임 추가**.

| 칸 | 적을 것 |
|---|---|
| id | 영어 소문자·숫자·`-`, 2~40자. 예: `word-adventure`, `farm-toss`. **나중에 바꿀 수 없으니** 신중히. 2단계에서 `project` 값으로 씁니다. |
| 이름 | 관리자 화면에 보일 이름. 예: `말씀의 모험` |
| 플랫폼 | 앱인토스 / 게임졸트 / 웹 / 그 밖 |
| 허용 주소 | 한 줄에 하나. **모르면 비워 두세요** (아래 3단계에서 채움) |

같은 게임을 앱인토스와 게임졸트에 둘 다 올렸다면 **플랫폼마다 프로젝트를 따로** 만드는 것을 권합니다 (예: `farm-toss`, `farm-gj`). 신고 목록을 플랫폼별로 거를 수 있고 허용 주소도 섞이지 않습니다.

### 허용 주소 쓰는 법

| 적는 값 | 뜻 |
|---|---|
| `https://example.com` | 그 주소에서 연 게임만 (끝의 `/`는 있어도 없어도 같음, 경로는 쓰지 않음) |
| `https://*.example.com` | 그 도메인의 모든 하위 주소 |
| `http://localhost:5173` | 내 컴퓨터에서 개발 중일 때 (포트까지 맞아야 함) |
| `native` | Origin이 없는 곳 — 설치형(다운로드) 빌드, 앱 안 웹뷰 일부 |
| `null` | 샌드박스 iframe 등에서 Origin이 `null`로 오는 경우 |
| `*` | 어디서든 (시험할 때만 잠깐. 운영에서는 쓰지 마세요) |

**실제 주소를 모를 때 (앱인토스 웹뷰·게임졸트 HTML 빌드가 이 경우)**
1. 허용 주소를 비운 채로 게임을 실제 플랫폼에 올립니다.
2. 게임에서 📣 신고를 한 번 보냅니다 → 게임에는 실패로 뜹니다 (정상).
3. 관리자 **게임 · 연결** 탭의 그 프로젝트에 **막힌 주소**가 나타납니다 → **[허용에 추가]** (Origin이 없었다면 **[native 허용]**) → **저장**.
4. 다시 보내면 들어옵니다.

프로젝트 카드의 **게임에 붙이는 코드**를 펼치면 2단계에 쓸 코드가 그 프로젝트 id로 채워져 나옵니다.

---

## 2단계 — 게임에 SDK 붙이기 (AI 작업자)

### 2-1. 넣는 방법 (둘 중 하나)

**A. `<script>` 태그 (가장 간단, 빌드 도구 없는 게임·Unity WebGL 템플릿)**

```html
<script src="https://s-qatools.giornogiobana1234.workers.dev/sdk/qa-report.js"></script>
```

**B. 파일 복사 (Vite·webpack 등 번들러, 또는 외부 스크립트를 막는 플랫폼)**

이 저장소의 `public/sdk/qa-report.js`와 `public/sdk/qa-report.d.ts`를 게임 저장소(예: `src/vendor/`)에 복사하고:

```js
import './vendor/qa-report.js';   // window.QAReport 가 생김
const QAReport = window.QAReport;
```

SDK를 고치면 복사본도 다시 복사해야 하니, 가능하면 A를 쓰세요.

### 2-2. 초기화 — 게임이 시작될 때 한 번

```js
QAReport.init({
  endpoint: 'https://s-qatools.giornogiobana1234.workers.dev',
  project: 'farm-toss',          // 1단계에서 만든 id
  platform: 'toss',              // 'toss' | 'gamejolt' | 'web' | 'other'
  version: '0.3.1',              // 게임 버전 (package.json 등에서 가져오면 좋음)
  channel: 'test',               // 출시판은 'prod' → 화면 구석 '테스트판' 표시가 사라짐
  build: '2026-11-25 a1b2c3d',   // 선택: 빌드 날짜·커밋

  // 신고에 함께 붙일 지금 진행 상황 (작고 단순한 값만)
  getContext: () => ({ scene: game.sceneName, stage: game.stageId, score: game.score }),

  // 신고 창이 떠 있는 동안 게임과 소리를 멈춤
  onPause: () => game.pause(),
  onResume: () => game.resume(),
});
```

| 옵션 | 언제 쓰나 |
|---|---|
| `canvas` | 캔버스가 여러 개일 때 사진 찍을 캔버스 (선택자·요소·함수). 없으면 가장 큰 canvas |
| `captureScreenshot` | WebGL이라 사진이 까맣게 나올 때 직접 찍어 주는 함수 (아래 엔진별 참고) |
| `button: false` | 떠 있는 📣 단추를 숨기고, 게임 메뉴의 「의견 보내기」에서 `QAReport.open()` 호출 |
| `button: { position: 'top-left' }` | 단추 위치 (`bottom-right` 기본, `bottom-left`, `top-right`, `top-left`) — 게임 UI와 겹칠 때 |
| `lang` | `'ko'` / `'en'` / 비우면 브라우저 언어 따라감 (게임졸트는 비워 두기 권장) |
| `kinds` | 신고 종류 바꾸기. 기본은 `bug, stuck, art_sound, fun, suggestion, other` |
| `badge: false` | 테스트판 표시를 강제로 숨김 |

종류를 더하고 싶으면:

```js
kinds: ['bug', 'stuck', { id: 'lesson', emoji: '💡', label: '교훈', hint: '말씀이 잘 전해졌나요?' }, 'suggestion', 'other'],
```
`id`는 영어 소문자로 시작하고 소문자·숫자·`_`만 됩니다. 관리자 화면은 기본 종류와 `lesson`(💡 교훈)만 이름으로 보여 주고, 나머지는 id 그대로 보입니다.

### 2-3. 3분 기록 남기기 — 게임 곳곳에

오류(`error`, `unhandledrejection`, `console.error`)와 누르기·터치는 SDK가 **알아서** 기록합니다.
개발자가 재현할 때 도움이 되는 **게임 사건**만 짧게 더해 주세요. 같은 내용이 이어지면 `×n`으로 묶이므로 자주 불러도 됩니다.

```js
QAReport.note('단계', '2-1 시작');
QAReport.note('장면', '상점 열기');
QAReport.note('선택', '대답 B');
QAReport.note('결과', '실패: 시간 초과');
```

좋은 곳: 장면·단계 바뀔 때, 중요한 선택, 성공/실패, 저장/불러오기, 광고·결제 창 열고 닫을 때.
**넣지 말 것**: 이름·전화번호·토스 사용자 키 같은 개인정보, 매 프레임 호출.

### 2-4. 그 밖의 API

```js
QAReport.open({ kind: 'bug', message: '...' });   // 신고 창 직접 열기 (값은 미리 채우기, 선택)
QAReport.setButtonVisible(false);                  // 컷신·튜토리얼 동안 단추 숨기기
QAReport.send({ kind: 'bug', message: '자동 보고: 저장 실패' });  // 창 없이 바로 보내기 (남용 금지: IP당 1시간 10건)
```

### 엔진별 주의

- **Canvas 2D**: 그대로 됩니다.
- **Phaser (WebGL)**: 사진이 까맣게 나오면 게임 설정에 `render: { preserveDrawingBuffer: true }`, 또는
  ```js
  captureScreenshot: () => new Promise((r) => game.renderer.snapshot((img) => r(img.src))),
  onPause: () => { game.loop.sleep(); game.sound.pauseAll(); },
  onResume: () => { game.loop.wake(); game.sound.resumeAll(); },
  ```
- **Unity WebGL**: WebGL 템플릿 `index.html`에 2-1 A의 `<script>`와 2-2의 `init`을 넣고,
  `createUnityInstance`의 config에 `webglContextAttributes: { preserveDrawingBuffer: true }`.
  `onPause`/`onResume`에서는 `unityInstance.SendMessage('GameManager', 'Pause')`처럼 C#을 부르세요.
  C#에서 `note()`/`open()`을 직접 부르려면 `.jslib` 다리를 만들어야 합니다 (아직 없음).
- **React·Vue 등 DOM UI 게임**: 사진은 캔버스만 찍습니다. 캔버스가 없으면 사진 없이 보내집니다.

### 플랫폼별 주의

- **앱인토스**
  - `platform: 'toss'`. 출시 전에 **외부 서버 호출·화면 위 떠 있는 단추**에 대한 검수 기준을 확인하세요.
  - 부담되면 운영판(`channel: 'prod'`)에서 `button: false` + 설정 메뉴에 「의견 보내기」 → `QAReport.open()`.
  - 웹뷰의 Origin은 1단계의 **막힌 주소** 방법으로 확인하세요.
- **게임졸트**
  - `platform: 'gamejolt'`, `lang`은 비워 두기 (해외 플레이어).
  - HTML(브라우저) 빌드: Origin은 **막힌 주소** 방법으로 확인.
  - 설치형(다운로드) 빌드: 허용 주소에 `native`.
  - 브라우저 빌드와 설치형 빌드를 둘 다 낸다면 둘 다 허용 주소에 넣으세요.

### 하지 말 것

- `ADMIN_KEY`·`IP_SALT`를 게임에 넣기 (게임에는 필요 없음)
- `endpoint`를 게임 저장소의 다른 서버로 바꾸기 / SDK 파일 내용을 고쳐서 쓰기 (고칠 게 있으면 이 저장소에서)
- `getContext()`에 큰 객체(게임 전체 상태, 이미지) 넣기 — 작고 사람이 읽을 수 있는 값만
- 허용 주소 `*`로 출시하기

---

## 3단계 — 확인 (사람)

1. 게임을 실제 플랫폼(또는 테스트판)에서 엽니다. 화면 구석에 `테스트판 · v0.3.1`, 아래에 📣 단추가 보이면 SDK가 켜진 것.
2. 📣 → 종류 고르기 → 한 줄 쓰기 → 보내기.
3. 실패하면 1단계의 **막힌 주소** 처리 후 다시.
4. 관리자 **신고** 탭에서 확인: 사진, 3분 기록(직접 넣은 `note`가 보이는지), 진행 상황(`getContext` 값), 환경(화면 크기·브라우저).
5. 확인이 끝난 시험 신고는 상세에서 지우거나 상태를 **보류**로 두세요.

**출시 전 체크리스트**
- [ ] `project` id가 관리자 페이지와 같다
- [ ] `channel: 'prod'`, `version`이 실제 출시 버전
- [ ] 허용 주소에 `*`·`localhost` 없음 (개발용 주소는 따로 개발용 프로젝트로)
- [ ] 신고 창이 뜰 때 게임·소리가 멈추고, 닫으면 다시 시작
- [ ] 사진이 까맣지 않음
- [ ] 앱인토스: 검수 기준에 맞게 단추 노출 방식 결정

## 문제 해결

| 증상 | 원인 → 해결 |
|---|---|
| 보내기 실패, 관리자에 **막힌 주소**가 생김 | 허용 주소 문제 → [허용에 추가] |
| 보내기 실패, 막힌 주소도 없음 | `project` id 오타이거나, 그 프로젝트의 **신고 받기**가 꺼져 있음 (서버는 둘 다 404) |
| "인터넷이 불안해서 저장해 뒀어요" | 네트워크 실패 → 기기에 저장했다가 다음에 게임을 켤 때 다시 보냄 |
| 한 시간쯤 안 들어감 | 같은 곳(IP)에서 1시간 10건 한도. **사무실처럼 여럿이 같은 와이파이로 시험하면 금방 찹니다** — 한도는 이 저장소 `wrangler.jsonc`의 `RATE_LIMIT_PER_HOUR` |
| 사진이 너무 크다고 실패 | 700KB 넘음 → SDK가 줄여서 보내지만, `captureScreenshot`으로 직접 찍었다면 크기를 줄여 주세요 |
| 사진이 까맣다 | WebGL → 엔진별 주의 참고 |
| 📣 단추가 안 보임 | 스크립트가 안 불러짐 (플랫폼이 외부 스크립트를 막음 → 2-1 B 방법) 또는 `button: false` |

---

## AI 작업자에게 그대로 붙여 넣을 지시문

> 아래를 복사해서 게임 저장소를 맡은 AI(ChatGPT 등)에게 주세요. `<…>` 부분만 바꾸면 됩니다.
> 이 문서 전체를 함께 붙여 넣으면 더 정확합니다.

```text
이 게임에 QA 신고 SDK를 붙여 줘. 플레이어가 게임 안에서 버그·의견을 보내면 우리 신고함 서버로 모이는 도구야.

- 신고함 주소(endpoint): https://s-qatools.giornogiobana1234.workers.dev
- 프로젝트 id(project): <farm-toss>
- 플랫폼(platform): <toss | gamejolt | web>
- 이번 빌드 채널(channel): <test | prod>

할 일:
1. SDK를 불러와. 빌드 도구가 없으면 index.html에
   <script src="https://s-qatools.giornogiobana1234.workers.dev/sdk/qa-report.js"></script>
   번들러를 쓰면 내가 줄 qa-report.js / qa-report.d.ts 파일을 src/vendor/ 에 두고 import 해.
2. 게임이 준비된 직후 QAReport.init({...}) 을 한 번 불러.
   - version 은 게임의 실제 버전 값을 가져와 (하드코딩 말고 package.json·설정에서).
   - getContext 는 지금 장면·단계 같은 작고 읽기 쉬운 값만 돌려줘.
   - onPause / onResume 에서 게임 루프와 소리를 멈추고 다시 켜.
   - WebGL이면 사진이 까맣지 않게 preserveDrawingBuffer 를 켜거나 captureScreenshot 을 써.
3. 장면·단계 전환, 중요한 선택, 성공/실패, 저장/불러오기 지점에 QAReport.note('종류', '짧은 설명') 을 넣어.
   매 프레임 호출이나 개인정보(이름, 사용자 키 등)는 넣지 마.
4. 비밀 키는 필요 없어. 어떤 키나 토큰도 추가하지 마. SDK 파일 내용은 고치지 마.
5. 끝나면 바꾼 파일 목록과, 3분 기록에 남도록 note를 넣은 위치를 정리해 줘.

SDK API: init(options), note(kind, text), open(preset?), close(), send(report), setButtonVisible(bool)
옵션 전체는 qa-report.d.ts 참고.
```
