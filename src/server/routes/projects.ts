import { Router } from 'express';
import { projectQueries, accountQueries, aiConfigQueries, templateQueries, scheduleRuleQueries, projectBenchmarkingQueries } from '../../storage/db';
import { runBenchmarkingForProject, getBenchmarkingStatus } from '../../benchmarking/runner';
import { threadsApi } from '../../threads/threadsApi';

const router = Router();

router.get('/', (req, res) => res.json(projectQueries.getAll()));

router.post('/', (req, res) => {
  const { name, description = '' } = req.body;
  if (!name) return res.status(400).json({ error: '프로젝트 이름이 필요합니다.' });
  const result = projectQueries.create({ name, description }) as any;
  res.json({ id: Number(result.lastInsertRowid), name, description });
});

router.put('/:id', (req, res) => {
  const { name, description, is_active } = req.body;
  projectQueries.update({ name, description, is_active: is_active ? 1 : 0, id: req.params.id });
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  projectQueries.delete(req.params.id);
  res.json({ success: true });
});

// ─── 계정 ──────────────────────────────────────────────────────────────────
router.get('/:id/accounts', (req, res) => res.json(accountQueries.getByProject(req.params.id)));

router.post('/:id/accounts', (req, res) => {
  const { username, display_name = '' } = req.body;
  if (!username) return res.status(400).json({ error: '유저네임이 필요합니다.' });
  const profile_dir = `threads_${username}_${Date.now()}`;
  const result = accountQueries.create({ project_id: req.params.id, username, display_name, profile_dir }) as any;
  res.json({ id: Number(result.lastInsertRowid), username, display_name, profile_dir });
});

router.put('/:id/accounts/:accId', (req, res) => {
  const { username, display_name, is_active } = req.body;
  accountQueries.update({ username, display_name, is_active: is_active ? 1 : 0, id: req.params.accId });
  res.json({ success: true });
});

router.delete('/:id/accounts/:accId', (req, res) => {
  accountQueries.delete(req.params.accId);
  res.json({ success: true });
});

// API 토큰 저장 (토큰 검증 후 계정에 연결)
router.put('/:id/accounts/:accId/token', async (req, res) => {
  const { access_token, threads_user_id, token_expires_at } = req.body;
  if (!access_token) return res.status(400).json({ error: 'access_token이 필요합니다.' });

  let userId = threads_user_id;
  if (!userId) {
    const me = await threadsApi.getMe(access_token);
    if (!me) return res.status(400).json({ error: '토큰이 유효하지 않습니다. 만료되었거나 잘못된 토큰입니다.' });
    userId = me.id;
  }

  accountQueries.setToken(req.params.accId, { access_token, threads_user_id: userId, token_expires_at });
  res.json({ success: true, threads_user_id: userId });
});

// API 토큰 삭제
router.delete('/:id/accounts/:accId/token', (req, res) => {
  accountQueries.clearToken(req.params.accId);
  res.json({ success: true });
});

// ─── AI 설정 ───────────────────────────────────────────────────────────────
router.get('/:id/ai-configs', (req, res) => res.json(aiConfigQueries.getByProject(req.params.id)));

router.post('/:id/ai-configs', (req, res) => {
  const { name, ai_type, url, prompt_template = '', input_selector = '', submit_selector = '', output_selector = '' } = req.body;
  if (!name || !url) return res.status(400).json({ error: '이름과 URL이 필요합니다.' });
  const profile_dir = `ai_${ai_type || 'custom'}_${Date.now()}`;
  const result = aiConfigQueries.create({ project_id: req.params.id, name, ai_type: ai_type || 'claude', url, prompt_template, profile_dir, input_selector, submit_selector, output_selector }) as any;
  res.json({ id: Number(result.lastInsertRowid), name, ai_type, url, profile_dir });
});

router.put('/:id/ai-configs/:cfgId', (req, res) => {
  const { name, ai_type, url, prompt_template, input_selector, submit_selector, output_selector, is_active } = req.body;
  aiConfigQueries.update({ name, ai_type, url, prompt_template, input_selector, submit_selector, output_selector, is_active: is_active ? 1 : 0, id: req.params.cfgId });
  res.json({ success: true });
});

router.delete('/:id/ai-configs/:cfgId', (req, res) => {
  aiConfigQueries.delete(req.params.cfgId);
  res.json({ success: true });
});

// ─── 포스트 템플릿 ─────────────────────────────────────────────────────────
router.get('/:id/templates', (req, res) => res.json(templateQueries.getByProject(req.params.id)));

router.post('/:id/templates', (req, res) => {
  const { name, main_prompt, comment_template = '', hashtags = [] } = req.body;
  const result = templateQueries.create({ project_id: req.params.id, name: name || '기본 템플릿', main_prompt: main_prompt || '', comment_template, hashtags: JSON.stringify(hashtags) }) as any;
  res.json({ id: Number(result.lastInsertRowid) });
});

router.put('/:id/templates/:tmplId', (req, res) => {
  const { name, main_prompt, comment_template, hashtags, is_active } = req.body;
  templateQueries.update({ name, main_prompt, comment_template, hashtags: JSON.stringify(hashtags), is_active: is_active ? 1 : 0, id: req.params.tmplId });
  res.json({ success: true });
});

router.delete('/:id/templates/:tmplId', (req, res) => {
  templateQueries.delete(req.params.tmplId);
  res.json({ success: true });
});

// ─── 스케줄 규칙 ───────────────────────────────────────────────────────────
router.get('/:id/schedules', (req, res) => res.json(scheduleRuleQueries.getByProject(req.params.id)));

router.post('/:id/schedules', (req, res) => {
  const { account_id, ai_config_id, template_id, preview_time, post_times, active_days, timing_variance_min } = req.body;
  const result = scheduleRuleQueries.create({
    project_id: req.params.id, account_id, ai_config_id, template_id,
    preview_time: preview_time || '09:00',
    post_times: JSON.stringify(post_times || ['18:00']),
    active_days: JSON.stringify(active_days || [1, 2, 3, 4, 5, 6, 7]),
    timing_variance_min: timing_variance_min || 5,
  }) as any;
  res.json({ id: Number(result.lastInsertRowid) });
});

router.put('/:id/schedules/:ruleId', (req, res) => {
  const { preview_time, post_times, active_days, timing_variance_min, is_active } = req.body;
  scheduleRuleQueries.update({ preview_time, post_times: JSON.stringify(post_times), active_days: JSON.stringify(active_days), timing_variance_min, is_active: is_active ? 1 : 0, id: req.params.ruleId });
  res.json({ success: true });
});

router.delete('/:id/schedules/:ruleId', (req, res) => {
  scheduleRuleQueries.delete(req.params.ruleId);
  res.json({ success: true });
});

// ─── 벤치마킹 설정 ─────────────────────────────────────────────────────────
router.get('/:id/benchmarking', (req, res) => {
  const config = projectBenchmarkingQueries.getByProject(req.params.id);
  res.json({ success: true, data: config || null });
});

router.put('/:id/benchmarking', (req, res) => {
  try {
    const { is_enabled, interval_hours, posts_per_run, posting_account_id, ai_config_id, rewrite_prompt, targets } = req.body;
    projectBenchmarkingQueries.upsert({
      project_id: Number(req.params.id),
      is_enabled: is_enabled ? 1 : 0,
      interval_hours: interval_hours || 6,
      posts_per_run: posts_per_run || 1,
      posting_account_id: posting_account_id || null,
      ai_config_id: ai_config_id || null,
      rewrite_prompt: rewrite_prompt || '',
      targets: JSON.stringify(targets || []),
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:id/benchmarking/run', (req, res) => {
  const { running } = getBenchmarkingStatus();
  if (running) {
    return res.json({ success: false, message: '벤치마킹이 이미 실행 중입니다.' });
  }
  // force=true: 활성화 여부 무관하게 수동 실행
  runBenchmarkingForProject(Number(req.params.id), true).catch(console.error);
  res.json({ success: true, message: `벤치마킹 실행 시작 — 서버 콘솔에서 진행상황 확인 가능 (타겟당 2~4분 소요)` });
});

export default router;
