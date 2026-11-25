# 📣 QA 신고함

앱인토스·게임졸트에 올린 서비스 안에 **「신고」 단추**를 달고, 플레이어가 보낸 신고를 한곳에 모아 **접수 → 확인 → 수정 중 → 완료**로 처리하는 도구입니다.

```
게임 (qa-report.js)                         Cloudflare Worker (이 저장소)                  관리자 페이지 /admin
 📣 단추 → 게임·소리 멈춤 → 화면 사진       POST /api/reports                              목록 · 거르기 · 찾기
 종류 고르기 + 한 줄 (🎤 말로도)      ──▶  · 프로젝트별 허용 주소(CORS) 확인          ──▶  사진 · 3분 기록 · 환경
 최근 3분 기록(오류·조작) 자동 첨부          · 한 곳에서 1시간 10건 제한                     상태 · 심각도 · 우선순위 · 메모
 인터넷 끊기면 저장 후 다음에 다시           · 사진 → R2, 나머지 → D1                        처리 기록 · 평균 처리 일수
                                             · (선택) 디스코드 알림                           🤖 Claude 프롬프트 복사
```

| 폴더 | 내용 |
|---|---|
| `src/index.ts` | Worker: 신고 받기 API, 관리자 API |
| `migrations/` | D1 표 (projects, reports, report_events, origin_rejections) |
| `public/sdk/qa-report.js` | 게임에 넣는 SDK (의존성 없음, 한국어/영어) — `/sdk/qa-report.js`로도 제공 |
| `public/admin/` | 관리자 페이지 (빌드 없음) |
| `public/demo/` | 시험용 데모 게임 |
| `src/ops.ts` | 관제: JSON 로그, 시간별 사건 수, 오류 기록, 디스코드 알림, 상태 점검 |
| `scripts/smoke.mjs` | 끝에서 끝까지 API·관제 확인 (34개 항목) |

## 내 컴퓨터에서 돌려 보기

```powershell
npm install
copy .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

- 데모 게임: http://localhost:8787/demo/ → **고장 난 단추**를 누른 뒤 📣 신고 (오류가 미리 골라짐)
- 관리자: http://localhost:8787/admin/ → 열쇠는 `.dev.vars`의 `ADMIN_KEY`
- 확인 테스트 (서버를 켜 둔 채로): `npm run test:e2e`

로컬에서는 wrangler가 D1·R2를 흉내 내므로 Cloudflare 계정이 없어도 됩니다.

## Cloudflare에 올리기 (처음 한 번)

로그인과 비밀 값 입력은 직접 하세요.

```powershell
npx wrangler login
npx wrangler d1 create qatool
```
→ 나온 `database_id`를 `wrangler.jsonc`의 **`"binding": "DB"` 항목**의 `database_id`에 넣으세요.
wrangler가 "설정 파일에 추가할까요?"라고 물어 새 항목을 덧붙였다면, 그 항목은 지우고 id만 `DB` 항목으로 옮기세요
(코드는 `DB`만 씁니다. `d1_databases`에는 항목이 하나만 있어야 합니다).

```powershell
npx wrangler r2 bucket create qatool-shots
npx wrangler secret put ADMIN_KEY
npx wrangler secret put IP_SALT
npm run db:migrate:remote
npm run deploy
```

선택: `npx wrangler secret put DISCORD_WEBHOOK_URL` — 새 신고마다 디스코드 채널로 알림.

올린 뒤 `https://qatool.<계정>.workers.dev/admin/` → **게임 · 연결** 탭에서 게임을 추가하면 붙일 코드가 나옵니다.
운영에서는 `demo` 프로젝트의 **신고 받기**를 꺼 두세요.

### GitHub에 푸시하면 자동 배포 (Workers Builds)

한 번 연결해 두면 `main`에 푸시할 때마다 Cloudflare가 `npx wrangler deploy`를 대신 실행합니다 (무료: 한 달 빌드 3,000분, 동시 1개).

**연결 전에 (내 컴퓨터에서 한 번)**
1. 위의 `wrangler login` → `d1 create` → `DB` 항목에 진짜 `database_id` 넣기 → `r2 bucket create` 까지 하고, `wrangler.jsonc`를 **커밋·푸시**합니다.
   (`database_id`는 비밀이 아니라 저장소에 올려도 됩니다. 비밀 값은 절대 `wrangler.jsonc`에 넣지 마세요.)
2. `npm run db:migrate:remote` 로 표를 만듭니다.
3. `PUBLIC_URL`을 쓰려면 `wrangler.jsonc`의 `vars`에 적어 커밋하세요. 배포할 때마다 이 파일의 `vars`가 대시보드 값을 덮어씁니다.

**대시보드에서 연결**
1. Workers & Pages → **만들기** → **저장소 가져오기(Import a repository)** → GitHub 앱 권한 허락 → 이 저장소 선택.
   (이미 `npm run deploy`로 만든 Worker가 있다면: 그 Worker → **Settings → Builds → Connect**.)
2. 설정:

   | 칸 | 값 |
   |---|---|
   | Worker 이름 | `qatool` (`wrangler.jsonc`의 `name`과 같아야 함) |
   | Production branch | `main` |
   | Build command | 비워 둠 (빌드할 것 없음) |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/` |
   | Non-production branch builds (Previews) | **끔** — 켜 두면 다른 브랜치 미리보기가 운영과 같은 D1·R2에 시험 신고를 씁니다 |

3. Worker → **Settings → Variables & Secrets** 에 `ADMIN_KEY`, `IP_SALT`, (선택) `DISCORD_WEBHOOK_URL`을 **Secret**으로 넣습니다.
   빌드 설정의 *Build variables and secrets* 칸이 아닙니다 — 거기 넣은 값은 실행 중인 Worker에서 보이지 않습니다.
4. 첫 빌드가 끝나면 관리자 페이지 **관제** 탭에서 *지금 배포된 판*이 바뀌었는지 확인합니다.

**새 마이그레이션 파일을 추가할 때 (주의)**
Workers Builds가 자동으로 만드는 배포 토큰에는 Workers·KV·R2 권한만 있고 **D1 권한이 없어서**, 빌드 안에서는 표를 바꿀 수 없습니다.
새 코드가 새 표를 쓰므로 순서가 중요합니다. 둘 중 하나를 고르세요.

- **손으로 (간단)**: `migrations/`에 파일을 추가했다면 **푸시하기 전에** `npm run db:migrate:remote` 를 먼저 실행.
  표만 먼저 늘어나는 것은 지금 돌고 있는 코드에 영향이 없습니다.
- **자동으로**: [API 토큰](https://dash.cloudflare.com/profile/api-tokens)을 직접 만들어 *Workers Scripts 편집 + D1 편집 + Workers R2 Storage 편집 + Account Settings 읽기* 권한을 주고,
  빌드 설정의 **API token**에서 그 토큰을 고른 뒤 Deploy command를 이렇게 바꿉니다:

  ```
  npx wrangler d1 migrations apply qatool --remote && npx wrangler deploy
  ```

**되돌리기**: 배포가 잘못됐으면 Worker → **Deployments** 에서 이전 버전을 골라 *Rollback*. (D1 표 변경은 되돌려지지 않으니, 마이그레이션은 열(column)·표를 **추가만** 하는 식으로 쓰는 것이 안전합니다.)

## 관제 (배포 뒤 상태 보기)

**관리자 페이지 → 관제 탭** 한 화면에서 봅니다 (1분마다 새로 고침):

| 칸 | 보여 주는 것 |
|---|---|
| 서버 (D1 · R2) | 데이터베이스와 사진 저장소가 응답하는지, 몇 ms 걸리는지 |
| 지금 배포된 판 | 돌고 있는 Worker 버전 ID와 배포 시각 — 롤백했는지 바로 확인 |
| 마지막 신고 · 매시 정기 점검 | 신고가 끊기지 않았는지, cron 이 제때 도는지 (2시간 넘게 안 돌면 ⚠️) |
| 사건 수 | 받은 신고 / 막힌 주소 / 한도 초과 / 잘못된 신고 / 서버 오류 / 알림 실패 / 관리자 열쇠 실패 (문제가 있으면 노란색) |
| 그래프 | 시간별 받은 신고, 시간별 문제 요청 (24시간 · 3일 · 7일) |
| 최근 서버 오류 | 오류 내용 + Ray ID (복사해서 Cloudflare 로그에서 같은 요청 찾기) |
| 저장 공간 | D1 크기와 사진 용량을 무료 한도(500MB / 10GB)와 비교 |

**알림** (`DISCORD_WEBHOOK_URL` 을 넣었을 때, 관제 탭의 [시험 알림 보내기]로 확인)
- 🚨 서버 오류·사진 저장 실패: 바로 (같은 종류는 10분에 한 번)
- 🚨 매시 점검에서 D1·R2 이상
- ⚠️ 한 시간에 한도 초과 20번 / 막힌 주소 20번 / 관리자 열쇠 실패 10번 / 신고 50건 이상
- 📊 매일 오전 9시 하루 요약 — 알림 속 관리자 링크를 쓰려면 `wrangler.jsonc` 의 `PUBLIC_URL` 에 배포 주소를 넣으세요.

**Cloudflare 쪽**
- `wrangler.jsonc` 의 `observability` 로 **Workers Logs**와 **Issues**(같은 오류 묶기)가 켜집니다. 대시보드 → Workers & Pages → qatool → **Observability** 에서 `event`, `route`, `status`, `ms`, `project`, `ray` 필드로 거를 수 있어요 (코드가 요청마다 JSON 한 줄을 남김).
- 터미널에서 실시간: `npm run logs` (전부), `npm run logs:errors` (오류만).
- 바깥 감시: `https://<주소>/api/health` 는 정상이면 200, D1·R2 중 하나라도 이상하면 503 → UptimeRobot 같은 무료 감시에 등록하면 Worker 자체가 죽었을 때도 알 수 있습니다.

로컬에서 정기 점검 시험: `npm run dev` 를 켜고 http://localhost:8787/__scheduled?cron=0+*+*+*+* 열기.

## 게임에 붙이기

```html
<script src="https://qatool.<계정>.workers.dev/sdk/qa-report.js"></script>
<script>
  QAReport.init({
    endpoint: 'https://qatool.<계정>.workers.dev',
    project: 'my-game',
    platform: 'toss',            // 'toss' | 'gamejolt' | 'web'
    version: '0.1.0',
    channel: 'test',             // 운영판은 'prod' (구석 '테스트판' 표시가 사라짐)
    getContext: () => ({ scene: currentScene, stage: stageName }),
    onPause: () => game.pause(),
    onResume: () => game.resume(),
  });
  QAReport.note('단계', '2-1 시작');   // 게임 곳곳에 — 3분 기록에 남음
</script>
```

번들러(Vite 등)를 쓰면 `public/sdk/qa-report.js`를 프로젝트에 복사해 `import './qa-report.js'` 후 `window.QAReport`를 쓰고, 타입은 `qa-report.d.ts`를 함께 복사하세요.

자주 쓰는 옵션: `kinds`(종류 바꾸기, 예: 교훈 `lesson` 추가), `button: false`(단추 없이 메뉴에서 `QAReport.open()`), `lang: 'en'`, `captureScreenshot`(직접 찍기).

### 엔진별 주의

- **Phaser (WebGL)**: 캔버스 사진이 까맣게 나오면 게임 설정에 `render: { preserveDrawingBuffer: true }`를 넣거나
  `captureScreenshot: () => new Promise(r => game.renderer.snapshot(img => r(img.src)))`를 쓰세요.
  멈춤은 `onPause: () => { game.loop.sleep(); game.sound.pauseAll(); }`.
- **Unity WebGL**: WebGL 템플릿의 `config`에 `webglContextAttributes: { preserveDrawingBuffer: true }`. C#에서 `note()`/`open()`을 부르는 `.jslib` 다리는 아직 없습니다.
- **Canvas 2D**: 그대로 됩니다.

### 플랫폼별

- **허용 주소를 모를 때**: 프로젝트를 허용 주소 없이 만들고 실제 플랫폼에서 신고를 한 번 보내 보세요.
  **게임 · 연결** 탭에 *막힌 주소*가 뜨고, [허용에 추가]를 누르면 됩니다. 앱인토스 웹뷰와 게임졸트 HTML 빌드의 실제 Origin은 이 방법으로 확인하세요 (이 저장소에서는 아직 실제 플랫폼에서 확인하지 않았습니다).
- **게임졸트**: 해외 플레이어가 많으므로 `lang`을 비워 두면 브라우저 언어에 따라 한국어/영어로 바뀝니다. 설치형(다운로드) 빌드는 Origin이 없으므로 허용 주소에 `native`를 넣으세요.
- **앱인토스**: 외부 서버 호출·화면 위 단추에 대한 검수 기준이 있는지 출시 전에 확인하세요. 운영판에서 단추가 부담되면 `button: false`로 두고 설정 메뉴에 「의견 보내기」를 달아 `QAReport.open()`을 부르면 됩니다.

## 신고를 Claude로 처리하기

신고 상세에서 **🤖 Claude 프롬프트 복사**를 누르면, 재현 → 가장 작게 수정 → 테스트판 확인 → 「원인 / 고친 것 / 확인 방법」 정리를 시키는 글에 신고 내용(3분 기록·환경·진행 상황)이 붙어 복사됩니다. 게임 저장소에서 Claude Code에 붙여 넣으세요.
목록 아래 **묶어 분류 프롬프트**는 지금 보이는 신고를 원인별로 묶고 심각도·우선순위를 매기게 합니다.
처리 결과는 **처리 메모**와 **고친 판**에 남기고 상태를 **완료**로 바꾸면 평균 처리 일수에 들어갑니다.

## 개인정보

이름·연락처는 보내지 않습니다. IP는 소금(`IP_SALT`)을 섞은 해시만 한도 계산에 쓰고, 관리자 API에서도 보이지 않습니다. 3분 기록은 게임 메모리에만 있다가 신고할 때만 함께 보냅니다.
