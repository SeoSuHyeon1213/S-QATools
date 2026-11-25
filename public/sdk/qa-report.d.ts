export interface QAKind {
  id: string;
  emoji: string;
  label: string;
  hint?: string;
  /** true 면 '재미있었다 / 그저 그렇다 / 지루했다' 정도를 고르게 함 */
  rated?: boolean;
}

export interface QAReportOptions {
  /** 신고함 Worker 주소, 예: https://qatool.<계정>.workers.dev */
  endpoint: string;
  /** 관리자 페이지에서 만든 프로젝트 id */
  project: string;
  version?: string;
  /** 'test' | 'prod' 등. prod 가 아니면 화면 구석에 '테스트판 · v…' 표시 */
  channel?: string;
  /** 'toss' | 'gamejolt' | 'web' | 'other' */
  platform?: string;
  /** 빌드 날짜·커밋 등 */
  build?: string;
  /** 'ko' | 'en' | 'auto'(기본: 브라우저 언어) */
  lang?: string;
  /** 게임 캔버스 (선택자, 요소, 또는 함수). 없으면 가장 큰 canvas */
  canvas?: string | HTMLCanvasElement | (() => HTMLCanvasElement | null);
  /** WebGL 등 toDataURL 이 비어 나올 때 직접 찍어 주는 함수 (data URL 또는 canvas 반환) */
  captureScreenshot?: () => string | HTMLCanvasElement | null | Promise<string | HTMLCanvasElement | null>;
  /** 신고에 붙일 진행 상황, 예: { scene: '2-1', stage: '씨 뿌리기' } */
  getContext?: () => Record<string, unknown>;
  /** 신고 창이 뜰 때 게임과 소리를 멈추기 */
  onPause?: () => void;
  onResume?: () => void;
  onSent?: (res: { id: number }) => void;
  /** 종류 목록. 문자열은 기본 종류(bug, stuck, art_sound, fun, suggestion, other) */
  kinds?: Array<string | QAKind>;
  /** 정도를 고르는 종류 (기본: fun) */
  ratedKinds?: string[];
  /** false 면 떠 있는 단추 없음 (QAReport.open() 을 직접 부르기) */
  button?: false | { position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' };
  badge?: boolean;
  voice?: boolean;
  captureConsoleError?: boolean;
  keepMs?: number;
  shotMaxEdge?: number;
  texts?: Record<string, unknown>;
}

export interface QAReportApi {
  init(options: QAReportOptions): QAReportApi;
  /** 최근 3분 기록에 한 줄 남기기. 예: note('누름', '점프'), note('단계', '2-1 시작') */
  note(kind: string, text: string): void;
  open(preset?: { kind?: string; message?: string; context?: Record<string, unknown> }): void;
  close(): void;
  send(report: { kind: string; message?: string; rating?: 'good' | 'meh' | 'bad'; shot?: string; context?: Record<string, unknown> }): Promise<{ ok: true; id: number }>;
  getTrail(): Array<{ ago: number; kind: string; text: string; n: number }>;
  setButtonVisible(visible: boolean): void;
  version: string;
}

declare const QAReport: QAReportApi;
export default QAReport;
declare global {
  interface Window { QAReport: QAReportApi }
}
