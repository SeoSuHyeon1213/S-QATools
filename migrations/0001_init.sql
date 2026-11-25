-- 게임(프로젝트)마다 신고를 나눠 받습니다.
CREATE TABLE projects (
  id              TEXT PRIMARY KEY,                 -- 'bible-adventure' 같은 짧은 이름
  name            TEXT NOT NULL,
  platform        TEXT NOT NULL DEFAULT 'web',      -- toss | gamejolt | web | other
  allowed_origins TEXT NOT NULL DEFAULT '[]',       -- JSON 배열. '*', 'https://*.example.com', 'native' 허용
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE TABLE reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  kind        TEXT NOT NULL,            -- bug | stuck | art_sound | fun | suggestion | other ...
  rating      TEXT,                     -- 재미 같은 평가형 종류의 정도: good | meh | bad
  message     TEXT NOT NULL DEFAULT '',
  version     TEXT,                     -- 게임 버전
  channel     TEXT,                     -- test | prod
  platform    TEXT,                     -- 신고가 온 플랫폼 (toss, gamejolt ...)
  context     TEXT,                     -- JSON: 게임이 알려 준 진행 상황 (장면, 단계, 몇 분째 ...)
  env         TEXT,                     -- JSON: 화면 크기, 터치 여부, 브라우저, 언어
  trail       TEXT,                     -- JSON: 최근 3분 기록 [{ago, kind, text, n}]
  shot_key    TEXT,                     -- R2 에 저장한 화면 사진 키
  status      TEXT NOT NULL DEFAULT 'new',  -- new(접수) | confirmed(확인) | fixing(수정 중) | done(완료) | wontfix(보류)
  severity    TEXT,                     -- critical | major | minor | trivial
  priority    TEXT,                     -- p1 | p2 | p3
  assignee    TEXT,
  dev_note    TEXT,                     -- 원인 / 고친 것 / 확인 방법
  fixed_in    TEXT,                     -- 고친 버전
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  resolved_at INTEGER                   -- done / wontfix 가 된 시각 → 평균 처리 일수
);
CREATE INDEX idx_reports_project_created ON reports(project_id, created_at DESC);
CREATE INDEX idx_reports_status ON reports(status);
CREATE INDEX idx_reports_ip ON reports(ip_hash, created_at);

-- "상태를 바꾼 날짜도 남겨" → 처리 기록
CREATE TABLE report_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL REFERENCES reports(id),
  field      TEXT NOT NULL,
  from_value TEXT,
  to_value   TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX idx_events_report ON report_events(report_id, at);

-- 허용하지 않은 주소에서 온 신고. 앱인토스·게임졸트의 실제 출처 주소를 알아내는 데 씁니다.
CREATE TABLE origin_rejections (
  project_id TEXT NOT NULL,
  origin     TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  last_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, origin)
);

-- 로컬 시험용 데모 프로젝트
INSERT INTO projects (id, name, platform, allowed_origins, created_at)
VALUES ('demo', '데모 게임', 'web', '["http://localhost:8787","http://127.0.0.1:8787"]', unixepoch() * 1000);
