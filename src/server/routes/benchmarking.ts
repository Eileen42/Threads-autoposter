import { Router } from 'express';
import { runBenchmarking, runBenchmarkingForProject, runBenchmarkingForTarget, getBenchmarkingStatus, getBenchmarkingProgress, stopBenchmarking } from '../../benchmarking/runner';
import { projectBenchmarkingQueries } from '../../storage/db';

const router = Router();

// POST /api/benchmarking/run  – manual global trigger (non-blocking)
router.post('/run', (_req, res) => {
  const { running } = getBenchmarkingStatus();
  if (running) {
    return res.json({ success: false, message: '이미 실행 중입니다.' });
  }
  res.json({ success: true, message: '벤치마킹 전체 실행 시작' });
  runBenchmarking().catch(console.error);
});

// GET /api/benchmarking/status
router.get('/status', (_req, res) => {
  res.json({ success: true, data: getBenchmarkingStatus() });
});

// GET /api/benchmarking/progress  – 실시간 진행 상황 (프론트 폴링용)
router.get('/progress', (_req, res) => {
  res.json(getBenchmarkingProgress());
});

// GET /api/benchmarking/overview  – 프로젝트별 현황 (통계 포함)
router.get('/overview', (_req, res) => {
  const { running, since } = getBenchmarkingStatus();
  const projects = projectBenchmarkingQueries.getOverview();
  res.json({ running, since, projects });
});

// POST /api/benchmarking/stop
router.post('/stop', (_req, res) => {
  const { running } = getBenchmarkingStatus();
  if (!running) return res.json({ success: false, message: '실행 중인 스크랩이 없습니다.' });
  stopBenchmarking();
  res.json({ success: true, message: '정지 요청됨. 현재 작업 완료 후 중단됩니다.' });
});

// POST /api/benchmarking/run/:projectId  – 특정 프로젝트만 수동 실행
router.post('/run/:projectId', (req, res) => {
  const projectId = Number(req.params.projectId);
  if (isNaN(projectId)) return res.status(400).json({ error: '잘못된 프로젝트 ID' });
  const { running } = getBenchmarkingStatus();
  if (running) return res.json({ success: false, message: '이미 실행 중입니다.' });
  res.json({ success: true });
  runBenchmarkingForProject(projectId, true).catch(console.error);
});

// POST /api/benchmarking/run-target  – 특정 대상 URL만 수동 스크랩
router.post('/run-target', (req, res) => {
  const { projectId, targetUrl } = req.body;
  if (!projectId || !targetUrl) return res.status(400).json({ error: 'projectId와 targetUrl이 필요합니다.' });
  const { running } = getBenchmarkingStatus();
  if (running) return res.json({ success: false, message: '이미 실행 중입니다.' });
  res.json({ success: true });
  runBenchmarkingForTarget(Number(projectId), String(targetUrl), true).catch(console.error);
});

export default router;
