import cron from 'node-cron';
import path from 'path';
import {
  scheduleRuleQueries, postQueries, templateQueries,
  aiConfigQueries, accountQueries, addLog, projectBenchmarkingQueries,
} from '../storage/db';
import { aiClient } from '../ai/aiClient';
import { threadsPoster } from '../threads/threadsPoster';
import {
  parseTimeToToday, getTodayDayNumber,
  addTimingVariance, sleep, randomInt
} from '../human/humanBehavior';
import { runBenchmarkingForProject } from '../benchmarking/runner';
import { benchmarkingPoster } from '../benchmarking/poster';
import { cleanupPostMedia } from '../benchmarking/mediaDownloader';
import { threadsApi } from '../threads/threadsApi';

let schedulerRunning = false;
const activeTasks: cron.ScheduledTask[] = [];
let isPostingRunning = false;   // runDuePosts 중복 실행 방지
let isGeneratingRunning = false; // generateTodayPosts 중복 실행 방지
let postingStartedAt = 0;
let generatingStartedAt = 0;

export function getSchedulerActiveTasks(): Array<{ id: string; label: string; since: number }> {
  const tasks: Array<{ id: string; label: string; since: number }> = [];
  if (isGeneratingRunning) tasks.push({ id: 'generating', label: '콘텐츠 생성 중', since: generatingStartedAt });
  if (isPostingRunning) tasks.push({ id: 'posting', label: '포스팅 중', since: postingStartedAt });
  if (isNativeSchedulingRunning) tasks.push({ id: 'scheduling', label: '예약 등록 중', since: nativeSchedulingStartedAt });
  return tasks;
}

// ─── 콘텐츠 생성 ─────────────────────────────────────────────────────────────
async function generatePostContent(postId: number, aiConfigId: number, templateId: number): Promise<void> {
  const aiConfig = aiConfigQueries.getById(aiConfigId);
  const template = templateQueries.getById(templateId);

  if (!aiConfig || !template) {
    postQueries.markFailed({ id: postId, error_message: 'AI 설정 또는 템플릿을 찾을 수 없습니다.' });
    return;
  }

  addLog(postId, 'info', `AI 콘텐츠 생성 시작: ${aiConfig.name}`);

  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const prompt = (template.main_prompt as string)
    .replace('{date}', today)
    .replace('{today}', today);

  try {
    const generatedContent = await aiClient.generateContent(aiConfig, prompt);
    if (!generatedContent || generatedContent.trim().length === 0) throw new Error('AI가 빈 응답을 반환했습니다.');

    const hashtags: string[] = JSON.parse(template.hashtags as string || '[]');
    const hashtagStr = hashtags.length > 0 ? '\n\n' + hashtags.map(t => `#${t}`).join(' ') : '';
    const finalContent = generatedContent.trim() + hashtagStr;

    const commentContent = (template.comment_template as string) || '';

    postQueries.updateContent({ generated_content: finalContent, comment_content: commentContent, status: 'generated', id: postId });
    addLog(postId, 'info', `콘텐츠 생성 완료 (${finalContent.length}자)`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    addLog(postId, 'error', `콘텐츠 생성 실패: ${msg}`);
    postQueries.markFailed({ id: postId, error_message: msg });
  }
}

// ─── 실제 포스팅 ──────────────────────────────────────────────────────────────
async function executePost(post: any): Promise<void> {
  addLog(post.id, 'info', '포스팅 시작');
  postQueries.updateStatus({ status: 'posting', id: post.id });

  try {
    const account = accountQueries.getById(post.account_id);
    if (!account) throw new Error('계정 정보를 찾을 수 없습니다.');

    let result: { success: boolean; postUrl?: string; error?: string };

    // ─── API 발행 (텍스트 포스트 + 토큰 있는 경우) ──────────────────────────
    const hasApiToken = account.access_token && account.threads_user_id;
    const isTextPost = post.source_type !== 'benchmarking' ||
      !JSON.parse(post.media_paths || '[]').length;

    if (hasApiToken && isTextPost) {
      addLog(post.id, 'info', 'Threads API로 발행 시도');
      const apiResult = await threadsApi.publishText(
        account.threads_user_id,
        account.access_token,
        post.generated_content,
      );

      if (apiResult.success) {
        // 댓글이 있으면 API로 답글 작성
        if (post.comment_content?.trim() && apiResult.postId) {
          const replyResult = await threadsApi.createReply(
            account.threads_user_id,
            account.access_token,
            apiResult.postId,
            post.comment_content,
          );
          if (!replyResult.success) {
            addLog(post.id, 'warn', `댓글 작성 실패 (무시됨): ${replyResult.error}`);
          }
        }
        postQueries.markPosted({ id: post.id, post_url: apiResult.postUrl || '' });
        addLog(post.id, 'info', `API 발행 완료: ${apiResult.postUrl || '(URL 없음)'}`);
        return;
      }

      // API 실패 시 브라우저로 폴백
      addLog(post.id, 'warn', `API 발행 실패, 브라우저로 전환: ${apiResult.error}`);
    }

    // ─── 브라우저 자동화 발행 ────────────────────────────────────────────────
    if (post.source_type === 'benchmarking') {
      // 벤치마킹 포스트: 미디어 첨부 포스터 사용
      const mediaPaths: string[] = JSON.parse(post.media_paths || '[]');
      // URL paths (/media/123/file.jpg) → absolute file paths
      const absMediaPaths = mediaPaths.map((urlPath: string) => {
        const rel = urlPath.replace(/^\/media\//, '');
        return path.join(process.cwd(), 'data', 'media', rel);
      });
      result = await benchmarkingPoster.postWithMedia(
        account.profile_dir,
        post.generated_content,
        absMediaPaths,
        post.comment_content || '',
      );
      if (result.success) cleanupPostMedia(post.id);
    } else {
      result = await threadsPoster.post(account.profile_dir, post.generated_content, post.comment_content);
    }

    if (result.success) {
      postQueries.markPosted({ id: post.id, post_url: result.postUrl || '' });
      addLog(post.id, 'info', `포스팅 완료: ${result.postUrl || '(URL 없음)'}`);
    } else {
      throw new Error(result.error || '알 수 없는 오류');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    addLog(post.id, 'error', `포스팅 실패: ${msg}`);
    postQueries.markFailed({ id: post.id, error_message: msg });
  }
}

// ─── 오늘 포스트 생성 ─────────────────────────────────────────────────────────
export async function generateTodayPosts(): Promise<void> {
  if (isGeneratingRunning) {
    console.log('[Scheduler] 콘텐츠 생성 이미 실행 중 - 건너뜀');
    return;
  }
  isGeneratingRunning = true;
  generatingStartedAt = Date.now();
  try {
    console.log('[Scheduler] 오늘 포스트 생성 시작...');
    const today = getTodayDayNumber();
    const rules = scheduleRuleQueries.getActive();

    for (const rule of rules) {
      const activeDays: number[] = JSON.parse(rule.active_days);
      if (!activeDays.includes(today)) continue;

      const postTimesArr: string[] = JSON.parse(rule.post_times);

      for (const timeStr of postTimesArr) {
        const scheduledDate = parseTimeToToday(timeStr);
        const withVariance = addTimingVariance(scheduledDate, rule.timing_variance_min || 5);

        const existing = postQueries.checkExisting(rule.id, withVariance.toISOString());
        if (existing) continue;

        const result = postQueries.create({
          rule_id: rule.id,
          project_id: rule.project_id,
          account_id: rule.account_id,
          ai_config_id: rule.ai_config_id,
          template_id: rule.template_id,
          generated_content: '',
          comment_content: '',
          scheduled_time: withVariance.toISOString(),
          status: 'pending_generation',
        }) as any;

        const postId = Number(result.lastInsertRowid);
        console.log(`[Scheduler] 포스트 생성: #${postId} (${withVariance.toLocaleTimeString('ko-KR')})`);

        await generatePostContent(postId, rule.ai_config_id, rule.template_id);

        if (postTimesArr.length > 1) {
          await sleep(randomInt(3000, 8000));
        }
      }
    }
    console.log('[Scheduler] 오늘 포스트 생성 완료');
  } finally {
    isGeneratingRunning = false;
  }
}

// ─── 즉시 포스팅 (지금 포스팅 버튼용) ───────────────────────────────────────
async function runDuePosts(): Promise<void> {
  if (isPostingRunning) return;
  const posts = postQueries.getApproved();
  if (posts.length === 0) return;

  isPostingRunning = true;
  postingStartedAt = Date.now();
  try {
    for (const post of posts) {
      console.log(`[Scheduler] 즉시 포스팅: #${post.id} (@${post.username})`);
      await executePost(post);
      await sleep(randomInt(5000, 15000));
    }
  } finally {
    isPostingRunning = false;
  }
}

// ─── Threads 네이티브 예약 (단일 포스트) ─────────────────────────────────────
async function schedulePostNatively(post: any): Promise<void> {
  addLog(post.id, 'info', 'Threads 네이티브 예약 시작');
  postQueries.updateStatus({ status: 'posting', id: post.id });

  try {
    const account = accountQueries.getById(post.account_id);
    if (!account) throw new Error('계정 정보를 찾을 수 없습니다.');

    // scheduled_time 파싱 (UTC ISO 또는 SQLite datetime 형식 모두 처리)
    const rawTime = String(post.scheduled_time);
    const scheduledDate = rawTime.includes('T')
      ? new Date(rawTime)
      : new Date(rawTime.replace(' ', 'T') + 'Z');

    let result: { success: boolean; error?: string };

    if (post.source_type === 'benchmarking') {
      const mediaPaths: string[] = JSON.parse(post.media_paths || '[]');
      const absMediaPaths = mediaPaths.map((urlPath: string) => {
        const rel = urlPath.replace(/^\/media\//, '');
        return path.join(process.cwd(), 'data', 'media', rel);
      });
      result = await benchmarkingPoster.scheduleWithMedia(
        account.profile_dir,
        post.generated_content,
        absMediaPaths,
        post.comment_content || '',
        scheduledDate,
      );
    } else {
      result = await threadsPoster.schedule(
        account.profile_dir,
        post.generated_content,
        post.comment_content || '',
        scheduledDate,
      );
    }

    if (result.success) {
      postQueries.markScheduled(post.id);
      addLog(post.id, 'info', `네이티브 예약 완료: ${scheduledDate.toLocaleString('ko-KR')}`);
    } else {
      throw new Error(result.error || '알 수 없는 오류');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    addLog(post.id, 'error', `예약 실패: ${msg}`);
    postQueries.markFailed({ id: post.id, error_message: msg });
  }
}

// ─── 승인된 포스트 일괄 네이티브 예약 ────────────────────────────────────────
let isNativeSchedulingRunning = false;
let nativeSchedulingStartedAt = 0;

export function getNativeSchedulingStatus(): { running: boolean; since: number } {
  return { running: isNativeSchedulingRunning, since: nativeSchedulingStartedAt };
}

export async function runNativeScheduling(): Promise<void> {
  if (isNativeSchedulingRunning || isPostingRunning) return;
  const posts = postQueries.getApprovedForScheduling();
  if (posts.length === 0) return;

  isNativeSchedulingRunning = true;
  nativeSchedulingStartedAt = Date.now();
  console.log(`[Scheduler] 네이티브 예약 배치: ${posts.length}개 포스트`);

  try {
    for (const post of posts) {
      console.log(`[Scheduler] 예약 등록: #${post.id} (@${post.username}, ${post.scheduled_time})`);
      await schedulePostNatively(post);
      // 계정 간 브라우저 열기 부담 최소화: 포스트 사이 10~20초 대기
      await sleep(randomInt(10000, 20000));
    }
    console.log(`[Scheduler] 네이티브 예약 배치 완료 (${posts.length}개)`);
  } finally {
    isNativeSchedulingRunning = false;
  }
}

// ─── 스케줄러 시작 ────────────────────────────────────────────────────────────
export function startScheduler(): void {
  if (schedulerRunning) return;
  schedulerRunning = true;
  console.log('[Scheduler] 시작 (매 분 체크)');

  const mainTask = cron.schedule('* * * * *', async () => {
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = getTodayDayNumber();

    const rules = scheduleRuleQueries.getActive();
    const triggeredBmProjects = new Set<number>(); // 중복 실행 방지

    for (const rule of rules) {
      const activeDays: number[] = JSON.parse(rule.active_days);
      if (!activeDays.includes(today)) continue;
      if (rule.preview_time === timeStr) {
        console.log(`[Scheduler] 미리보기 시간: ${timeStr} (${rule.project_name})`);
        generateTodayPosts().catch(console.error);

        // ── preview_time에 동일 프로젝트 벤치마킹 트리거 ──
        if (!triggeredBmProjects.has(rule.project_id)) {
          const bmConfig = projectBenchmarkingQueries.getByProject(rule.project_id);
          if (bmConfig?.is_enabled) {
            console.log(`[Scheduler] 벤치마킹 트리거 (preview_time): project #${rule.project_id}`);
            triggeredBmProjects.add(rule.project_id);
            runBenchmarkingForProject(rule.project_id).catch(console.error);
          }
        }
      }
    }

    // publish_mode='auto'인 approved 포스트만 자동 발행 (사용자가 명시적으로 선택한 경우)
    // 기본값은 'native'이므로 대부분의 포스트는 여기서 처리되지 않음
    runDuePosts().catch(console.error);
    // runNativeScheduling은 제거됨: "쓰레드 예약" 버튼으로만 수동 트리거
    // (자동 실행 시 사용자가 검토 전에 예약되는 문제 방지)
  });

  activeTasks.push(mainTask);
}

export function stopScheduler(): void {
  activeTasks.forEach(task => task.stop());
  activeTasks.length = 0;
  schedulerRunning = false;
}

export async function triggerGeneration(postId: number): Promise<void> {
  const post = postQueries.getById(postId);
  if (!post) throw new Error(`포스트 #${postId}를 찾을 수 없습니다.`);
  // 재생성 전 상태 초기화 → 생성 중에도 미리보기에서 보이도록
  postQueries.resetForRegeneration(postId);
  await generatePostContent(postId, post.ai_config_id, post.template_id);
}

export async function triggerPost(postId: number): Promise<void> {
  const post = postQueries.getById(postId);
  if (!post) throw new Error(`포스트 #${postId}를 찾을 수 없습니다.`);
  await executePost(post);
}
