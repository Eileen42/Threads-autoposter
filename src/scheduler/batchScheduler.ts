import path from 'path';
import { postQueries, accountQueries, addLog } from '../storage/db';
import { threadsPoster } from '../threads/threadsPoster';
import { benchmarkingPoster } from '../benchmarking/poster';
import { sleep, randomInt } from '../human/humanBehavior';

let isBatchSchedulingRunning = false;
let batchSchedulingStartedAt = 0;
let lastBatchSummary: { success: number; failed: number } | null = null;

export function getBatchSchedulingStatus(): { running: boolean; since: number; lastSummary: { success: number; failed: number } | null } {
  return { running: isBatchSchedulingRunning, since: batchSchedulingStartedAt, lastSummary: lastBatchSummary };
}

export interface BatchScheduleResult {
  postId: number;
  success: boolean;
  error?: string;
}

/**
 * 선택된 포스트 ID 목록을 Threads 네이티브 예약으로 일괄 등록합니다.
 * 계정별로 브라우저를 한 번만 열고, 모든 포스트 예약이 완료된 후 닫습니다.
 */
export async function batchScheduleNative(postIds: number[]): Promise<{ results: BatchScheduleResult[] }> {
  if (isBatchSchedulingRunning) {
    throw new Error('배치 예약이 이미 실행 중입니다. 완료 후 다시 시도하세요.');
  }

  isBatchSchedulingRunning = true;
  batchSchedulingStartedAt = Date.now();
  const results: BatchScheduleResult[] = [];

  try {
    // 포스트 조회 및 유효성 검사
    const posts = postIds
      .map(id => postQueries.getById(id))
      .filter(Boolean)
      .filter(p => p.status === 'approved');

    if (posts.length === 0) {
      return { results: [] };
    }

    // 계정별 그룹핑 (같은 계정은 같은 브라우저에서 처리)
    const byAccount = new Map<number, any[]>();
    for (const post of posts) {
      const group = byAccount.get(post.account_id) || [];
      group.push(post);
      byAccount.set(post.account_id, group);
    }

    // 과거 시간인 포스트들이 모두 같은 시간으로 몰리지 않도록 순차 슬롯 추적
    // (포스트마다 30분씩 간격을 두어 Threads 예약이 분산됨)
    const batchNow = new Date();
    const minGapMs = 15 * 60 * 1000;        // 최소 15분 미래
    const slotIntervalMs = 30 * 60 * 1000;  // 슬롯 간격 30분
    let nextFallbackSlot = new Date(batchNow.getTime() + minGapMs);

    for (const [accountId, accountPosts] of byAccount) {
      const account = accountQueries.getById(accountId);
      if (!account) {
        for (const post of accountPosts) {
          const err = '계정 정보를 찾을 수 없습니다.';
          postQueries.markFailed({ id: post.id, error_message: err });
          addLog(post.id, 'error', err);
          results.push({ postId: post.id, success: false, error: err });
        }
        continue;
      }

      console.log(`[BatchScheduler] @${account.username}: ${accountPosts.length}개 예약 시작 (브라우저 1회 공유)`);

      // 계정당 브라우저 컨텍스트 1개 오픈
      const context = await threadsPoster.openContext(account.profile_dir);
      const page = await context.newPage();

      try {
        // 초기 이동 + 로그인 확인
        await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await sleep(randomInt(1500, 2500));

        const profileLinkCount = await page.locator('a[href^="/@"]').count();
        if (profileLinkCount === 0) {
          const err = '로그인이 필요합니다. 해당 계정으로 먼저 로그인하세요.';
          for (const post of accountPosts) {
            postQueries.markFailed({ id: post.id, error_message: err });
            addLog(post.id, 'error', err);
            results.push({ postId: post.id, success: false, error: err });
          }
          continue;
        }

        // 각 포스트 순차 처리 (브라우저 닫지 않음)
        for (let i = 0; i < accountPosts.length; i++) {
          const post = accountPosts[i];
          console.log(`[BatchScheduler] #${post.id} 예약 중... (${i + 1}/${accountPosts.length})`);
          postQueries.updateStatus({ status: 'posting', id: post.id });
          addLog(post.id, 'info', '배치 예약 시작');

          try {
            // 예약 시간 파싱
            const rawTime = String(post.scheduled_time);
            const scheduledDate = rawTime.includes('T')
              ? new Date(rawTime)
              : new Date(rawTime.replace(' ', 'T') + 'Z');

            // 15분 이상 미래면 사용자가 설정한 시간 그대로 사용.
            // 과거이거나 15분 미만이면 순차 슬롯 배정 (포스트마다 30분 간격).
            let targetTime: Date;
            if (scheduledDate.getTime() - batchNow.getTime() >= minGapMs) {
              targetTime = scheduledDate;
              // 명시적 시간이 다음 슬롯보다 늦으면 슬롯을 그 이후로 밀어줌
              if (targetTime.getTime() + slotIntervalMs > nextFallbackSlot.getTime()) {
                nextFallbackSlot = new Date(targetTime.getTime() + slotIntervalMs);
              }
            } else {
              targetTime = nextFallbackSlot;
              nextFallbackSlot = new Date(nextFallbackSlot.getTime() + slotIntervalMs);
            }

            let postResult: { success: boolean; error?: string };

            if (post.source_type === 'benchmarking') {
              const mediaPaths: string[] = JSON.parse(post.media_paths || '[]');
              const absMediaPaths = mediaPaths.map((urlPath: string) => {
                const rel = urlPath.replace(/^\/media\//, '');
                return path.join(process.cwd(), 'data', 'media', rel);
              });
              postResult = await benchmarkingPoster.scheduleWithMediaOnPage(
                page,
                post.generated_content,
                absMediaPaths,
                post.comment_content || '',
                targetTime,
              );
            } else {
              postResult = await threadsPoster.scheduleOnPage(
                page,
                post.generated_content,
                post.comment_content || '',
                targetTime,
              );
            }

            if (postResult.success) {
              postQueries.markScheduled(post.id);
              addLog(post.id, 'info', `배치 예약 완료: ${targetTime.toLocaleString('ko-KR')}`);
              results.push({ postId: post.id, success: true });
              console.log(`[BatchScheduler] #${post.id} 완료 ✅`);
            } else {
              const err = postResult.error || '알 수 없는 오류';
              postQueries.markFailed({ id: post.id, error_message: err });
              addLog(post.id, 'error', `배치 예약 실패: ${err}`);
              results.push({ postId: post.id, success: false, error: err });
              console.error(`[BatchScheduler] #${post.id} 실패: ${err}`);
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            postQueries.markFailed({ id: post.id, error_message: msg });
            addLog(post.id, 'error', `배치 예약 오류: ${msg}`);
            results.push({ postId: post.id, success: false, error: msg });
            console.error(`[BatchScheduler] #${post.id} 예외: ${msg}`);
          }

          // 포스트 사이 대기 (마지막 포스트 제외)
          if (i < accountPosts.length - 1) {
            console.log(`[BatchScheduler] 다음 포스트 대기 중...`);
            await sleep(randomInt(8000, 15000));
          }
        }
      } finally {
        // 모든 포스트 처리 완료 후 브라우저 닫기
        await page.close().catch(() => {});
        await context.close().catch(() => {});
        console.log(`[BatchScheduler] @${account.username} 브라우저 종료`);
      }

      // 다음 계정 처리 전 대기
      if ([...byAccount.keys()].indexOf(accountId) < byAccount.size - 1) {
        await sleep(randomInt(3000, 6000));
      }
    }

    const succeeded = results.filter(r => r.success).length;
    lastBatchSummary = { success: succeeded, failed: results.length - succeeded };
    console.log(`[BatchScheduler] 배치 예약 완료: ${succeeded}/${results.length}개 성공`);
    return { results };
  } finally {
    isBatchSchedulingRunning = false;
  }
}
