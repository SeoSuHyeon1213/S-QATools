-- 관제: 시간별 사건 수 (신고 접수, 막힘, 한도 초과, 서버 오류 ...)
CREATE TABLE ops_counters (
  hour       INTEGER NOT NULL,              -- floor(ms / 3600000)
  event      TEXT NOT NULL,                 -- report.accepted | report.rejected_origin | report.rate_limited | ...
  project_id TEXT NOT NULL DEFAULT '',
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, event, project_id)
);

-- 관제: 최근 서버 오류 (원인 메시지와 Cloudflare Ray ID → 대시보드 로그에서 찾기)
CREATE TABLE ops_errors (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  source  TEXT NOT NULL,                    -- 어느 부분에서 (report.submit, r2.put, admin, cron ...)
  message TEXT NOT NULL,
  ray     TEXT
);
CREATE INDEX idx_ops_errors_at ON ops_errors(at DESC);

-- 관제: 알림 간격 조절, 마지막 정기 점검 시각 등
CREATE TABLE ops_state (
  key   TEXT PRIMARY KEY,
  value TEXT,
  at    INTEGER NOT NULL
);

-- 사진 용량 합계를 R2 를 훑지 않고 알기 위해
ALTER TABLE reports ADD COLUMN shot_bytes INTEGER;
