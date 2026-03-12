import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { postQueries, logQueries, accountQueries, aiConfigQueries, templateQueries, projectBenchmarkingQueries } from '../../storage/db';
import { triggerGeneration, triggerPost } from '../../scheduler/scheduler';
import { batchScheduleNative, getBatchSchedulingStatus } from '../../scheduler/batchScheduler';
import { aiClient } from '../../ai/aiClient';
import { threadsPoster } from '../../threads/threadsPoster';

const router = Router();

// ─── 고정 경로 라우트 (파라미터 라우트보다 먼저 등록) ──────────────────────────

router.get('/today', (req, res) => res.json(postQueries.getToday()));
router.get('/preview', (req, res) => res.json(postQueries.getPendingPreview()));
router.get('/recent', (req, res) => {
  const filters: any = {};
  if (req.query.account_id) filters.account_id = Number(req.query.account_id);
  if (req.query.project_id) filters.project_id = Number(req.query.project_id);
  if (req.query.status) filters.status = String(req.query.status);
  res.json(postQueries.getRecent(filters));
});
router.get('/daily-counts', (_req, res) => res.json(postQueries.getDailyCounts()));
router.get('/benchmarking/:projectId', (req, res) => res.json(postQueries.getBenchmarkingByProject(req.params.projectId)));

// 배치 예약 상태 조회
router.get('/batch-schedule/status', (_req, res) => {
  res.json(getBatchSchedulingStatus());
});

// 배치 네이티브 예약 (선택된 포스트 ID 목록을 한 번에 예약)
router.post('/batch-schedule', async (req, res) => {
  try {
    const { postIds } = req.body;
    if (!Array.isArray(postIds) || postIds.length === 0) {
      return res.status(400).json({ error: 'postIds 배열이 필요합니다.' });
    }
    // 비동기 실행 (완료 대기하지 않고 즉시 응답)
    batchScheduleNative(postIds).catch(console.error);
    res.json({ success: true, message: `${postIds.length}개 포스트 배치 예약 시작됨` });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

// 발행 방식 설정: 'auto'(지정시간 자동발행) | 'native'(Threads 수동 배치예약)
router.post('/publish-mode', (req, res) => {
  const { postIds, mode } = req.body;
  if (!Array.isArray(postIds) || !['auto', 'native'].includes(mode)) {
    return res.status(400).json({ error: 'postIds 배열과 mode(auto|native)가 필요합니다.' });
  }
  postQueries.setPublishMode(postIds, mode);
  res.json({ ok: true, updated: postIds.length });
});

router.post('/approve-all', (_req, res) => {
  const posts = postQueries.getPendingPreview();
  const generated = posts.filter(p => p.status === 'generated');
  for (const post of generated) postQueries.approve(post.id);
  res.json({ approved: generated.length });
});

router.post('/create', (req, res) => {
  const { project_id, account_id, ai_config_id, template_id, scheduled_time } = req.body;
  if (!project_id || !account_id || !ai_config_id || !template_id || !scheduled_time) {
    return res.status(400).json({ error: '필수 필드가 누락되었습니다.' });
  }
  const result = postQueries.create({ rule_id: null, project_id, account_id, ai_config_id, template_id, generated_content: '', comment_content: '', scheduled_time, status: 'pending_generation' }) as any;
  res.json({ id: Number(result.lastInsertRowid) });
});

router.post('/login/account/:accountId', async (req, res) => {
  try {
    const account = accountQueries.getById(req.params.accountId);
    if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });
    threadsPoster.openForLogin(account.profile_dir as string, account.username as string).catch(console.error);
    res.json({ success: true, message: '브라우저가 열렸습니다. 로그인 후 닫으세요.' });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/login/ai/:aiConfigId', async (req, res) => {
  try {
    const config = aiConfigQueries.getById(req.params.aiConfigId);
    if (!config) return res.status(404).json({ error: 'AI 설정을 찾을 수 없습니다.' });
    aiClient.openForLogin(config).catch(console.error);
    res.json({ success: true, message: '브라우저가 열렸습니다. 로그인 후 닫으세요.' });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ─── 테스트 엔드포인트 ─────────────────────────────────────────────────────────

// AI 생성 테스트 (DB 저장 없음, 결과만 반환)
router.post('/test/ai-generate', async (req, res) => {
  try {
    const { ai_config_id, template_id } = req.body;
    if (!ai_config_id) return res.status(400).json({ error: 'ai_config_id가 필요합니다.' });

    const config = aiConfigQueries.getById(ai_config_id);
    if (!config) return res.status(404).json({ error: 'AI 설정을 찾을 수 없습니다.' });

    let prompt = '오늘의 짧은 일상 글을 300자 이내로 작성해줘.';
    if (template_id) {
      const template = templateQueries.getById(template_id);
      if (template) {
        const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
        prompt = (template.main_prompt as string)
          .replace('{date}', today)
          .replace('{today}', today);
      }
    }

    console.log(`[Test] AI 생성 테스트 시작: ${config.name}`);
    const content = await aiClient.generateContent(config, prompt);
    res.json({ success: true, content, prompt, ai_name: config.name });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Test] AI 생성 실패:', msg);
    res.status(500).json({ error: msg });
  }
});

// Threads 로그인 상태 확인 (로그인 때와 동일한 브라우저 설정으로 확인)
router.post('/test/check-login/:accountId', async (req, res) => {
  try {
    const account = accountQueries.getById(req.params.accountId);
    if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });

    // headless: false + 동일한 설정으로 열어야 저장된 세션이 정상 인식됨
    const context = await threadsPoster.openContext(account.profile_dir as string);
    const page = await context.newPage();
    try {
      await page.goto('https://www.threads.net', { waitUntil: 'domcontentloaded', timeout: 20000 });
      // JS 기반 인증 체크가 완료될 때까지 충분히 대기
      await page.waitForTimeout(5000);

      const url = page.url();

      // 1차: URL 기반 체크
      if (url.includes('/login') || url.includes('accounts/login')) {
        return res.json({ success: true, isLoggedIn: false, url, username: account.username });
      }

      // 2차: DOM 기반 체크 — 프로필 링크(/@username)가 존재해야 진짜 로그인 상태
      // Threads는 로그인 없이도 홈 URL을 유지하고 모달만 표시하는 경우가 있음
      let detectedUsername: string | null = null;
      try {
        const profileLinks = page.locator('a[href^="/@"]');
        await profileLinks.first().waitFor({ state: 'visible', timeout: 4000 });
        const href = await profileLinks.first().getAttribute('href');
        if (href) {
          const match = href.match(/^\/@([^/?]+)/);
          if (match) detectedUsername = match[1].toLowerCase();
        }
      } catch { /* 프로필 링크 없음 = 미로그인 */ }

      const isLoggedIn = detectedUsername !== null;
      res.json({ success: true, isLoggedIn, url, username: account.username, detectedUsername });
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[Test] 로그인 확인 실패:', msg);
    res.status(500).json({ error: msg });
  }
});

// ─── 파라미터 라우트 (고정 경로 아래에 위치) ─────────────────────────────────

router.get('/:id', (req, res) => {
  const post = postQueries.getById(req.params.id);
  if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });
  const logs = logQueries.getByPost(req.params.id);
  res.json({ ...post as object, logs });
});

router.put('/:id/content', (req, res) => {
  const { generated_content, comment_content } = req.body;
  const post = postQueries.getById(req.params.id);
  if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });
  // Don't downgrade status if already approved/posted/etc.
  const newStatus = ['pending_generation', 'generated'].includes(post.status as string) ? 'generated' : post.status as string;
  postQueries.updateContent({ generated_content, comment_content, status: newStatus, id: req.params.id });
  res.json({ success: true });
});

// ─── 미디어 관리 ────────────────────────────────────────────────────────────────

// 미디어 파일 추가 (base64 JSON 업로드)
router.post('/:id/media/add', (req, res) => {
  try {
    const post = postQueries.getById(req.params.id);
    if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });

    const { filename, data } = req.body;
    if (!filename || !data) return res.status(400).json({ error: 'filename과 data가 필요합니다.' });

    // Sanitize filename to prevent path traversal
    const safeFilename = path.basename(String(filename)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'upload';
    const mediaDir = path.join(process.cwd(), 'data', 'media', req.params.id);
    fs.mkdirSync(mediaDir, { recursive: true });

    const filePath = path.join(mediaDir, safeFilename);
    fs.writeFileSync(filePath, Buffer.from(String(data), 'base64'));

    const urlPath = `/media/${req.params.id}/${safeFilename}`;
    const existing: string[] = JSON.parse((post.media_paths as string) || '[]');
    existing.push(urlPath);
    postQueries.updateMediaPaths(req.params.id, JSON.stringify(existing));

    res.json({ success: true, urlPath, mediaPaths: existing });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// 미디어 파일 삭제 (인덱스 기반)
router.delete('/:id/media/:index', (req, res) => {
  try {
    const post = postQueries.getById(req.params.id);
    if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });

    const idx = parseInt(req.params.index, 10);
    const existing: string[] = JSON.parse((post.media_paths as string) || '[]');
    if (isNaN(idx) || idx < 0 || idx >= existing.length) {
      return res.status(400).json({ error: '유효하지 않은 인덱스입니다.' });
    }

    const urlPath = existing[idx];
    try {
      const rel = urlPath.replace(/^\/media\//, '');
      const filePath = path.join(process.cwd(), 'data', 'media', rel);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore file deletion errors */ }

    existing.splice(idx, 1);
    postQueries.updateMediaPaths(req.params.id, JSON.stringify(existing));

    res.json({ success: true, mediaPaths: existing });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put('/:id/scheduled-time', (req, res) => {
  try {
    const { scheduled_time } = req.body;
    if (!scheduled_time) return res.status(400).json({ error: 'scheduled_time이 필요합니다.' });
    const post = postQueries.getById(req.params.id);
    if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });
    postQueries.updateScheduledTime(req.params.id, scheduled_time);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/:id/approve', (req, res) => {
  const post = postQueries.getById(req.params.id);
  if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });

  // 예약 시간이 현재보다 과거이면 승인 차단
  const raw = String(post.scheduled_time || '');
  if (raw) {
    const scheduledDate = raw.includes('T') ? new Date(raw) : new Date(raw.replace(' ', 'T') + 'Z');
    if (!isNaN(scheduledDate.getTime()) && scheduledDate.getTime() <= Date.now()) {
      return res.status(400).json({ error: `예약 시간이 과거입니다 (${scheduledDate.toLocaleString('ko-KR')}). 미리보기에서 시간을 변경한 후 다시 승인해주세요.` });
    }
  }

  postQueries.approve(req.params.id);
  res.json({ success: true });
});

router.post('/:id/return', (req, res) => {
  postQueries.returnToPreview(req.params.id);
  res.json({ success: true });
});

router.post('/:id/skip', (req, res) => {
  postQueries.skip(req.params.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  try {
    const post = postQueries.getById(req.params.id);
    if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });
    // 미디어 파일 정리
    try {
      const mediaPaths: string[] = JSON.parse((post.media_paths as string) || '[]');
      if (mediaPaths.length > 0) {
        const mediaDir = path.join(process.cwd(), 'data', 'media', String(req.params.id));
        if (fs.existsSync(mediaDir)) fs.rmSync(mediaDir, { recursive: true, force: true });
      }
    } catch { /* 미디어 정리 실패는 무시 */ }
    postQueries.delete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// 벤치마킹 포스트: original_content로 AI 재작성 재실행
router.post('/:id/bm-rewrite', async (req, res) => {
  try {
    const post = postQueries.getById(req.params.id);
    if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });
    if (post.source_type !== 'benchmarking') return res.status(400).json({ error: '벤치마킹 포스트만 재실행 가능합니다.' });
    if (!post.original_content?.trim()) return res.status(400).json({ error: '원본 내용이 없습니다. 벤치마킹을 다시 실행하세요.' });

    const bmConfig = projectBenchmarkingQueries.getByProject(post.project_id);
    if (!bmConfig?.ai_config_id) return res.status(400).json({ error: 'AI 설정이 없습니다. 벤치마킹 설정에서 AI를 선택하세요.' });
    if (!bmConfig.rewrite_prompt?.trim()) return res.status(400).json({ error: '재작성 프롬프트가 없습니다. 벤치마킹 설정에서 프롬프트를 입력하세요.' });

    const aiConfig = aiConfigQueries.getById(bmConfig.ai_config_id);
    if (!aiConfig) return res.status(400).json({ error: 'AI 설정을 찾을 수 없습니다.' });

    // 플레이스홀더 교체 (runner.ts와 동일한 로직)
    let fullPrompt = (bmConfig.rewrite_prompt as string).trim();
    const hasBmPlaceholder = fullPrompt.includes('[벤치마킹 원문]');
    const hasCommentPlaceholder = fullPrompt.includes('[첫 번째 댓글]');
    if (hasBmPlaceholder) {
      fullPrompt = fullPrompt.replace(/\[벤치마킹 원문\]\s*:?\s*(\([^)]*\))?/g, `[벤치마킹 원문] :\n${post.original_content}`);
    }
    if (hasCommentPlaceholder && post.comment_content) {
      fullPrompt = fullPrompt.replace(/\[첫 번째 댓글\]\s*:?\s*(\([^)]*\))?/g, `[첫 번째 댓글] :\n${post.comment_content}`);
    }
    if (!hasBmPlaceholder) {
      fullPrompt += `\n\n[원본 게시글]:\n${post.original_content}`;
      if (post.comment_content) fullPrompt += `\n\n[참고 - 원본 첫 번째 댓글]:\n${post.comment_content}`;
    } else if (!hasCommentPlaceholder && post.comment_content) {
      fullPrompt += `\n\n[참고 - 원본 첫 번째 댓글]:\n${post.comment_content}`;
    }

    console.log(`[BM-Rewrite] post #${req.params.id} AI 재작성 시작...`);
    const rewritten = await aiClient.generateContent(aiConfig, fullPrompt);
    if (!rewritten?.trim()) return res.status(500).json({ error: 'AI 재작성에 실패했습니다.' });

    postQueries.updateContent({ generated_content: rewritten.trim(), comment_content: post.comment_content || '', status: 'generated', id: req.params.id });
    console.log(`[BM-Rewrite] post #${req.params.id} 완료 (${rewritten.trim().length}자)`);
    res.json({ success: true, generated_content: rewritten.trim() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[BM-Rewrite] 오류:', msg);
    res.status(500).json({ error: msg });
  }
});

router.post('/:id/regenerate', async (req, res) => {
  try {
    await triggerGeneration(Number(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/:id/post-now', async (req, res) => {
  try {
    const post = postQueries.getById(req.params.id);
    if (!post) return res.status(404).json({ error: '포스트를 찾을 수 없습니다.' });
    // failed 상태면 generated로 초기화 후 재게시
    if (post.status === 'failed') postQueries.returnToPreview(req.params.id);
    if (post.status === 'generated' || post.status === 'failed') postQueries.approve(req.params.id);
    await triggerPost(Number(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
