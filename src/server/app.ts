import express from 'express';
import path from 'path';
import { initDB } from '../storage/db';
import { startScheduler, getSchedulerActiveTasks } from '../scheduler/scheduler';
import { getBenchmarkingStatus } from '../benchmarking/runner';
import { getBatchSchedulingStatus } from '../scheduler/batchScheduler';
import projectRoutes from './routes/projects';
import postRoutes from './routes/posts';
import benchmarkingRoutes from './routes/benchmarking';
import scrapesRoutes from './routes/scrapes';
import { scheduleRuleQueries, postQueries } from '../storage/db';

const app = express();
const PORT = 4000;

// ─── CORS + Private Network Access ──────────────────────────────────────────
// 웹 호스팅 프론트(HTTPS) → 사용자 PC localhost 백엔드 호출 허용.
// 환경변수 ALLOWED_ORIGINS (콤마 구분) 로 추가 도메인 지정 가능.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4000',
  'http://127.0.0.1:4000',
];
const extraOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]);
// *.vercel.app 과 배포 도메인 패턴도 허용 (와일드카드)
const allowedOriginPatterns = [
  /^https:\/\/[a-z0-9-]+\.vercel\.app$/i,
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  let allow = false;
  if (origin) {
    if (allowedOrigins.has(origin)) allow = true;
    else if (allowedOriginPatterns.some(p => p.test(origin))) allow = true;
  }
  if (allow && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  // Chrome Private Network Access (HTTPS → http://localhost 허용)
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// ─── Health check (프론트 연결 상태 판정용) ──────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: 1, ts: Date.now() });
});

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/media', express.static(path.join(process.cwd(), 'data', 'media')));

app.use('/api/projects', projectRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/benchmarking', benchmarkingRoutes);
app.use('/api/scrapes', scrapesRoutes);

app.get('/api/scheduler/active-tasks', (_req, res) => {
  const tasks = getSchedulerActiveTasks();
  const bm = getBenchmarkingStatus();
  const batch = getBatchSchedulingStatus();
  if (bm.running) {
    tasks.push({ id: 'benchmarking', label: '벤치마킹 스크랩 중', since: bm.since });
  }
  if (batch.running) {
    tasks.push({ id: 'batch-scheduling', label: '배치 예약 등록 중', since: batch.since });
  }
  res.json({ tasks });
});

app.get('/api/scheduler/status', (_req, res) => {
  const rules = scheduleRuleQueries.getAll();
  const preview = postQueries.getPendingPreview();
  const todayPosted = postQueries.getTodayPosted();
  const totalPosted = postQueries.getTotalPosted();
  res.json({
    running: true,
    activeRules: rules.filter(r => r.is_active).length,
    pendingApproval: preview.filter(p => p.status === 'generated').length,  // 승인 대기
    pendingSchedule: preview.filter(p => p.status === 'approved').length,   // 발행 대기 (사이드바 뱃지용)
    totalPosted: totalPosted,   // 포스팅 완료 전체 (예약됨 + 발행됨)
    todayPosted: todayPosted,   // 오늘 게시완료 (posted + scheduled, posted_at 기준)
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

export function startServer(): void {
  initDB();

  app.listen(PORT, () => {
    console.log(`\n🚀 Threads AutoPoster 실행 중`);
    console.log(`📌 브라우저에서 열기: http://localhost:${PORT}`);
    console.log('');
  });

  startScheduler();
}
