/**
 * 벤치마킹 워크플로우
 *
 * 트리거: 스케줄 관리의 preview_time에 runBenchmarkingForProject() 호출
 *
 * 워크플로우:
 *   1. 타겟 계정 프로필에서 게시글 목록 + 조회수 수집
 *   2. 이미 스크랩한 게시글 제외 → 신규 게시글 필터링
 *   3. 조회수 높은 순 정렬 → 상위 posts_per_run 개 선택
 *   4. 각 게시글: 본문 + 미디어 + 첫댓글(텍스트·링크 분리) 스크랩 + 검증
 *   5. 스크랩 데이터 → scrapes 테이블 저장 (원본 데이터 완전 기록)
 *   6. 미디어 다운로드
 *   7. AI 재작성 (본문·댓글 모두 컨텍스트로 포함)
 *   8. scheduled_post 생성 (원본/재작성 분리 저장)
 *      → 미리보기에서 원본·재작성 본문 + 원본·재작성 댓글 확인 후 승인
 */
import { isAlreadyScraped, markScraped } from './stateManager';
import { threadsScraper } from './scraper';
import { downloadMediaFiles, moveToPostMedia, cleanupTempMedia } from './mediaDownloader';
import { projectBenchmarkingQueries, accountQueries, aiConfigQueries, postQueries, scrapesQueries, appSettingsQueries } from '../storage/db';
import { aiClient } from '../ai/aiClient';
import { sleep, randomInt } from '../human/humanBehavior';

let isBenchmarkingRunning = false;
let benchmarkingStartedAt = 0;
let shouldStopBenchmarking = false;

export function stopBenchmarking(): void {
  if (isBenchmarkingRunning) {
    shouldStopBenchmarking = true;
    addProgress('⏹ 정지 요청됨 — 현재 작업 완료 후 중단됩니다...', 'info');
  }
}

// ─── 진행 상황 로그 ──────────────────────────────────────────────────────────
export interface ProgressEntry {
  time: number;
  msg: string;
  type: 'info' | 'done' | 'error';
}
const progressLog: ProgressEntry[] = [];
let progressTotal = 0;
let progressDone = 0;

function addProgress(msg: string, type: ProgressEntry['type'] = 'info'): void {
  progressLog.push({ time: Date.now(), msg, type });
  if (progressLog.length > 300) progressLog.splice(0, 1);
}

export function getBenchmarkingProgress(): {
  running: boolean;
  since: number;
  total: number;
  done: number;
  log: ProgressEntry[];
} {
  return {
    running: isBenchmarkingRunning,
    since: benchmarkingStartedAt,
    total: progressTotal,
    done: progressDone,
    log: progressLog.map(e => ({ ...e })),
  };
}

function extractKeyword(profileUrl: string): string {
  const m = profileUrl.match(/@([a-zA-Z0-9_.]+)/);
  return m ? m[1] : 'threads';
}

export async function runBenchmarkingForProject(projectId: number, force = false): Promise<void> {
  const config = projectBenchmarkingQueries.getByProject(projectId);
  if (!config) return;
  if (!force && !config.is_enabled) return;

  const postingAccount = config.posting_account_id
    ? accountQueries.getById(config.posting_account_id)
    : null;

  if (!postingAccount) {
    addProgress('⚠ 포스팅 계정이 설정되지 않았습니다. 프로젝트 설정에서 계정을 선택하세요.', 'error');
    return;
  }

  const aiConfig = config.ai_config_id ? aiConfigQueries.getById(config.ai_config_id) : null;
  const postsPerRun = Math.max(1, Number(config.posts_per_run) || 1);

  const targets: Array<{ url: string; enabled: boolean }> = JSON.parse(config.targets || '[]');
  const enabledTargets = targets.filter(t => t.enabled && t.url.trim());

  if (enabledTargets.length === 0) {
    addProgress('⚠ 활성화된 대상 계정이 없습니다. 벤치마킹 설정에서 대상 URL을 추가하세요.', 'error');
    return;
  }

  const manageFlag = !isBenchmarkingRunning;
  if (manageFlag) {
    isBenchmarkingRunning = true;
    shouldStopBenchmarking = false;
    benchmarkingStartedAt = Date.now();
    progressLog.length = 0;
    progressDone = 0;
  }
  progressTotal = enabledTargets.length;

  console.log(`\n[Benchmarking] ===== 프로젝트 #${projectId} 시작: ${enabledTargets.length}개 계정, 타겟당 ${postsPerRun}개 =====`);
  addProgress(`프로젝트 시작 — 대상 ${enabledTargets.length}개 계정, 타겟당 ${postsPerRun}개 스크랩`);

  try {
    for (const target of enabledTargets) {
      if (shouldStopBenchmarking) {
        addProgress('⏹ 정지됨 — 나머지 대상 건너뜀', 'info');
        break;
      }
      const targetIdx = enabledTargets.indexOf(target) + 1;
      const keyword = extractKeyword(target.url);
      addProgress(`[${targetIdx}/${enabledTargets.length}] @${keyword} 처리 시작...`);
      console.log(`\n[Benchmarking] ── 대상: ${target.url}`);

      const ctx = await threadsScraper.openContext(postingAccount.profile_dir as string);
      try {
        // ── STEP 1: 게시글 목록 수집 ──
        addProgress(`  ↳ 게시글 목록 수집 중...`);
        const postCards = await threadsScraper.getPostCards(
          target.url,
          postingAccount.profile_dir as string,
          ctx,
        );

        if (postCards.length === 0) {
          addProgress(`  ↳ ⚠ 게시글 없음 (로그인 확인 필요)`, 'error');
          progressDone++;
          continue;
        }
        addProgress(`  ↳ 게시글 ${postCards.length}개 발견`);

        // ── STEP 2: 이미 스크랩한 게시글 제외 ──
        const newPosts = postCards.filter(p => !isAlreadyScraped(target.url, p.url));
        if (newPosts.length === 0) {
          addProgress(`  ↳ 신규 게시글 없음 (${postCards.length}개 모두 이미 처리됨)`, 'info');
          progressDone++;
          continue;
        }

        // ── STEP 3: 조회수 순 정렬 → 상위 postsPerRun 개 선택 ──
        const selectedPosts = newPosts.slice(0, postsPerRun);
        addProgress(`  ↳ 신규 ${newPosts.length}개 중 ${selectedPosts.length}개 선택`);

        // ── STEP 4~8: 각 포스트 처리 ──
        for (let pi = 0; pi < selectedPosts.length; pi++) {
          if (shouldStopBenchmarking) break;

          const topPost = selectedPosts[pi];
          const postLabel = selectedPosts.length > 1 ? ` [${pi + 1}/${selectedPosts.length}]` : '';
          const hasViews = topPost.viewCount > 0;
          addProgress(
            `  ↳${postLabel} 스크랩 시작` +
            (hasViews ? ` (조회수 ${topPost.viewCount.toLocaleString()})` : '')
          );

          // ── STEP 4: 스크랩 ──
          const scraped = await threadsScraper.scrapePost(
            topPost.url,
            postingAccount.profile_dir as string,
            ctx,
          );

          if (!scraped) {
            addProgress(`  ↳${postLabel} ❌ 스크랩 실패 — 건너뜀`, 'error');
            markScraped(target.url, topPost.url); // 재시도 방지
            continue;
          }

          // ── 스크랩 결과 검증 로그 ──
          const methodTag = scraped.scrapeMethod === 'api' ? '[API]' : '[DOM]';
          addProgress(
            `  ↳${postLabel} ${methodTag} 본문 ${scraped.textContent.length}자` +
            (scraped.mediaUrls.length > 0 ? ` | 미디어 ${scraped.mediaUrls.length}개` : '') +
            (scraped.commentText ? ` | 댓글 ${scraped.commentText.length}자` : '') +
            (scraped.commentLinks.length > 0 ? ` | 링크 ${scraped.commentLinks.length}개` : '')
          );

          // ── STEP 5: scrapes 테이블에 원본 완전 저장 ──
          const sourceUsername = keyword;
          const scrapeResult = scrapesQueries.create({
            project_id: projectId,
            account_id: postingAccount.id,
            source_url: topPost.url,
            source_username: sourceUsername,
            text_content: scraped.textContent,
            first_comment: scraped.commentText || '',
            comment_links: JSON.stringify(scraped.commentLinks),
            media_urls: JSON.stringify(scraped.mediaUrls),
            media_local_paths: '[]',
          }) as any;
          const scrapeId = Number(scrapeResult.lastInsertRowid);

          // ── 브라우저 닫기 (마지막 포스트 처리 후 or 단일 포스트) ──
          if (pi === selectedPosts.length - 1) {
            await ctx.close().catch(() => {});
          }

          // ── STEP 6: 미디어 다운로드 ──
          let tempPaths: string[] = [];
          if (scraped.mediaUrls.length > 0) {
            addProgress(`  ↳${postLabel} 미디어 ${scraped.mediaUrls.length}개 다운로드 중...`);
            tempPaths = await downloadMediaFiles(scraped.mediaUrls, keyword);
            addProgress(`  ↳${postLabel} 미디어 ${tempPaths.length}개 다운로드 완료`);
          }

          // ── STEP 7: AI 재작성 ──
          let finalContent = scraped.textContent;
          // 댓글 재작성: AI가 [댓글] 섹션을 포함하면 분리, 아니면 원본 댓글 사용
          let rewrittenComment: string | undefined;

          if (aiConfig && config.rewrite_prompt?.trim()) {
            try {
              addProgress(`  ↳${postLabel} AI 재작성 중...`);

              let fullPrompt = (config.rewrite_prompt as string).trim();
              const hasBmPlaceholder = fullPrompt.includes('[벤치마킹 원문]');
              const hasCommentPlaceholder = fullPrompt.includes('[첫 번째 댓글]');

              if (hasBmPlaceholder) {
                fullPrompt = fullPrompt.replace(
                  /\[벤치마킹 원문\]\s*:?\s*(\([^)]*\))?/g,
                  `[벤치마킹 원문] :\n${scraped.textContent}`
                );
              }
              if (hasCommentPlaceholder && scraped.commentText) {
                fullPrompt = fullPrompt.replace(
                  /\[첫 번째 댓글\]\s*:?\s*(\([^)]*\))?/g,
                  `[첫 번째 댓글] :\n${scraped.commentText}`
                );
              }
              if (!hasBmPlaceholder) {
                fullPrompt += `\n\n[원본 게시글]:\n${scraped.textContent}`;
                if (scraped.commentText) {
                  fullPrompt += `\n\n[참고 - 원본 첫 번째 댓글]:\n${scraped.commentText}`;
                }
              } else if (!hasCommentPlaceholder && scraped.commentText) {
                fullPrompt += `\n\n[참고 - 원본 첫 번째 댓글]:\n${scraped.commentText}`;
              }

              const rewritten = await aiClient.generateContent(aiConfig, fullPrompt);
              if (rewritten && rewritten.trim().length > 0) {
                // [댓글] 구분자가 있으면 본문과 댓글 분리
                const commentSepMatch = rewritten.match(/[\n\r]+\[댓글\][\n\r]+([\s\S]+)$/);
                if (commentSepMatch) {
                  finalContent = rewritten.slice(0, rewritten.indexOf('\n[댓글]')).trim();
                  rewrittenComment = commentSepMatch[1].trim();
                } else {
                  finalContent = rewritten.trim();
                }
                addProgress(`  ↳${postLabel} AI 재작성 완료 (${finalContent.length}자${rewrittenComment ? ', 댓글 포함' : ''})`);
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              addProgress(`  ↳${postLabel} ⚠ AI 재작성 실패 — 원본 사용 (${errMsg.slice(0, 80)})`, 'error');
            }
          } else {
            addProgress(`  ↳${postLabel} AI 설정 없음 — 원본 그대로 저장`);
          }

          // comment_content: 재작성 댓글 있으면 사용, 없으면 원본 댓글 텍스트
          const commentContent = rewrittenComment ?? scraped.commentText ?? '';

          // ── STEP 8: scheduled_post 생성 ──
          const postResult = postQueries.createBenchmarking({
            project_id: projectId,
            account_id: postingAccount.id,
            generated_content: finalContent,
            original_content: scraped.textContent,
            comment_content: commentContent,
            original_comment: scraped.commentText || '',
            comment_links: JSON.stringify(scraped.commentLinks),
            source_url: topPost.url,
            media_paths: '[]',
          }) as any;
          const postId = Number(postResult.lastInsertRowid);

          scrapesQueries.linkPost(scrapeId, postId);

          // Google Sheets 자동 동기화
          const webhookUrl = appSettingsQueries.get('sheets_webhook_url');
          if (webhookUrl) {
            const row = {
              id: scrapeId,
              scraped_at: new Date().toISOString(),
              project_name: '',
              username: postingAccount.username,
              source_username: sourceUsername,
              source_url: topPost.url,
              text_content: scraped.textContent,
              first_comment: scraped.commentText || '',
              comment_links: scraped.commentLinks.join('\n'),
              media_urls: scraped.mediaUrls.join('\n'),
            };
            fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ rows: [row] }),
            }).catch(err => console.warn('[Benchmarking] Sheets 자동 동기화 실패:', err));
          }

          let mediaPaths: string[] = [];
          if (tempPaths.length > 0) {
            mediaPaths = moveToPostMedia(tempPaths, postId);
            postQueries.updateMediaPaths(postId, JSON.stringify(mediaPaths));
            scrapesQueries.updateMediaPaths(scrapeId, JSON.stringify(mediaPaths));
          }

          markScraped(target.url, topPost.url);
          addProgress(
            `  ✅${postLabel} 포스트 #${postId} 생성됨` +
            (mediaPaths.length > 0 ? ` (미디어 ${mediaPaths.length}개)` : ''),
            'done'
          );

          // 다음 포스트 처리 전 잠시 대기 (브라우저 부담 분산)
          if (pi < selectedPosts.length - 1 && !shouldStopBenchmarking) {
            await sleep(randomInt(3000, 6000));
          }
        } // end for selectedPosts

        progressDone++;

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Benchmarking] ❌ 오류 (${target.url}): ${msg}`);
        addProgress(`❌ @${keyword} 오류: ${msg.slice(0, 120)}`, 'error');
        progressDone++;
      } finally {
        await ctx.close().catch(() => {});
        cleanupTempMedia();
      }

      if (enabledTargets.indexOf(target) < enabledTargets.length - 1) {
        const delayMs = randomInt(15000, 30000);
        addProgress(`다음 대상까지 ${Math.round(delayMs / 1000)}초 대기 중...`);
        await sleep(delayMs);
      }
    }

    projectBenchmarkingQueries.updateLastChecked(projectId);
    addProgress(`🎉 전체 완료 — ${progressDone}개 대상 처리됨`, 'done');

  } finally {
    if (manageFlag) {
      isBenchmarkingRunning = false;
      shouldStopBenchmarking = false;
    }
  }
}

/**
 * 특정 대상 URL만 스크랩 (계정별 수동 스크랩 버튼용)
 */
export async function runBenchmarkingForTarget(projectId: number, targetUrl: string, force = false): Promise<void> {
  const config = projectBenchmarkingQueries.getByProject(projectId);
  if (!config) return;
  if (!force && !config.is_enabled) return;

  const postingAccount = config.posting_account_id
    ? accountQueries.getById(config.posting_account_id)
    : null;

  if (!postingAccount) {
    addProgress('⚠ 포스팅 계정이 설정되지 않았습니다. 프로젝트 설정에서 계정을 선택하세요.', 'error');
    return;
  }

  const aiConfig = config.ai_config_id ? aiConfigQueries.getById(config.ai_config_id) : null;
  const postsPerRun = Math.max(1, Number(config.posts_per_run) || 1);
  const keyword = extractKeyword(targetUrl);

  const manageFlag = !isBenchmarkingRunning;
  if (manageFlag) {
    isBenchmarkingRunning = true;
    shouldStopBenchmarking = false;
    benchmarkingStartedAt = Date.now();
    progressLog.length = 0;
    progressDone = 0;
  }
  progressTotal = 1;

  addProgress(`단일 대상 스크랩 시작: @${keyword} (타겟당 ${postsPerRun}개)`);
  console.log(`\n[Benchmarking] ── 단일 대상: ${targetUrl}`);

  const ctx = await threadsScraper.openContext(postingAccount.profile_dir as string);
  try {
    addProgress(`  ↳ 게시글 목록 수집 중...`);
    const postCards = await threadsScraper.getPostCards(targetUrl, postingAccount.profile_dir as string, ctx);

    if (postCards.length === 0) {
      addProgress(`  ↳ ⚠ 게시글 없음 (로그인 확인 필요)`, 'error');
      progressDone = 1;
      return;
    }
    addProgress(`  ↳ 게시글 ${postCards.length}개 발견`);

    const newPosts = postCards.filter(p => !isAlreadyScraped(targetUrl, p.url));
    if (newPosts.length === 0) {
      addProgress(`  ↳ 신규 게시글 없음 (${postCards.length}개 모두 이미 처리됨)`, 'info');
      progressDone = 1;
      return;
    }

    const selectedPosts = newPosts.slice(0, postsPerRun);
    addProgress(`  ↳ 신규 ${newPosts.length}개 중 ${selectedPosts.length}개 선택`);

    for (let pi = 0; pi < selectedPosts.length; pi++) {
      if (shouldStopBenchmarking) break;
      const topPost = selectedPosts[pi];
      const postLabel = selectedPosts.length > 1 ? ` [${pi + 1}/${selectedPosts.length}]` : '';
      const hasViews = topPost.viewCount > 0;
      addProgress(`  ↳${postLabel} 스크랩 시작${hasViews ? ` (조회수 ${topPost.viewCount.toLocaleString()})` : ''}`);

      const scraped = await threadsScraper.scrapePost(topPost.url, postingAccount.profile_dir as string, ctx);
      if (!scraped) {
        addProgress(`  ↳${postLabel} ❌ 스크랩 실패 — 건너뜀`, 'error');
        markScraped(targetUrl, topPost.url);
        continue;
      }

      const methodTag = scraped.scrapeMethod === 'api' ? '[API]' : '[DOM]';
      addProgress(
        `  ↳${postLabel} ${methodTag} 본문 ${scraped.textContent.length}자` +
        (scraped.mediaUrls.length > 0 ? ` | 미디어 ${scraped.mediaUrls.length}개` : '') +
        (scraped.commentText ? ` | 댓글 ${scraped.commentText.length}자` : '') +
        (scraped.commentLinks.length > 0 ? ` | 링크 ${scraped.commentLinks.length}개` : '')
      );

      const scrapeResult = scrapesQueries.create({
        project_id: projectId,
        account_id: postingAccount.id,
        source_url: topPost.url,
        source_username: keyword,
        text_content: scraped.textContent,
        first_comment: scraped.commentText || '',
        comment_links: JSON.stringify(scraped.commentLinks),
        media_urls: JSON.stringify(scraped.mediaUrls),
        media_local_paths: '[]',
      }) as any;
      const scrapeId = Number(scrapeResult.lastInsertRowid);

      if (pi === selectedPosts.length - 1) await ctx.close().catch(() => {});

      let tempPaths: string[] = [];
      if (scraped.mediaUrls.length > 0) {
        addProgress(`  ↳${postLabel} 미디어 ${scraped.mediaUrls.length}개 다운로드 중...`);
        tempPaths = await downloadMediaFiles(scraped.mediaUrls, keyword);
        addProgress(`  ↳${postLabel} 미디어 ${tempPaths.length}개 다운로드 완료`);
      }

      let finalContent = scraped.textContent;
      let rewrittenComment: string | undefined;

      if (aiConfig && config.rewrite_prompt?.trim()) {
        try {
          addProgress(`  ↳${postLabel} AI 재작성 중...`);
          let fullPrompt = (config.rewrite_prompt as string).trim();
          const hasBmPlaceholder = fullPrompt.includes('[벤치마킹 원문]');
          const hasCommentPlaceholder = fullPrompt.includes('[첫 번째 댓글]');
          if (hasBmPlaceholder) {
            fullPrompt = fullPrompt.replace(/\[벤치마킹 원문\]\s*:?\s*(\([^)]*\))?/g, `[벤치마킹 원문] :\n${scraped.textContent}`);
          }
          if (hasCommentPlaceholder && scraped.commentText) {
            fullPrompt = fullPrompt.replace(/\[첫 번째 댓글\]\s*:?\s*(\([^)]*\))?/g, `[첫 번째 댓글] :\n${scraped.commentText}`);
          }
          if (!hasBmPlaceholder) {
            fullPrompt += `\n\n[원본 게시글]:\n${scraped.textContent}`;
            if (scraped.commentText) fullPrompt += `\n\n[참고 - 원본 첫 번째 댓글]:\n${scraped.commentText}`;
          } else if (!hasCommentPlaceholder && scraped.commentText) {
            fullPrompt += `\n\n[참고 - 원본 첫 번째 댓글]:\n${scraped.commentText}`;
          }
          const rewritten = await aiClient.generateContent(aiConfig, fullPrompt);
          if (rewritten && rewritten.trim().length > 0) {
            const commentSepMatch = rewritten.match(/[\n\r]+\[댓글\][\n\r]+([\s\S]+)$/);
            if (commentSepMatch) {
              finalContent = rewritten.slice(0, rewritten.indexOf('\n[댓글]')).trim();
              rewrittenComment = commentSepMatch[1].trim();
            } else {
              finalContent = rewritten.trim();
            }
            addProgress(`  ↳${postLabel} AI 재작성 완료 (${finalContent.length}자${rewrittenComment ? ', 댓글 포함' : ''})`);
          }
        } catch (err) {
          addProgress(`  ↳${postLabel} ⚠ AI 재작성 실패 — 원본 사용`, 'error');
        }
      } else {
        addProgress(`  ↳${postLabel} AI 설정 없음 — 원본 그대로 저장`);
      }

      const commentContent = rewrittenComment ?? scraped.commentText ?? '';
      const postResult = postQueries.createBenchmarking({
        project_id: projectId,
        account_id: postingAccount.id,
        generated_content: finalContent,
        original_content: scraped.textContent,
        comment_content: commentContent,
        original_comment: scraped.commentText || '',
        comment_links: JSON.stringify(scraped.commentLinks),
        source_url: topPost.url,
        media_paths: '[]',
      }) as any;
      const postId = Number(postResult.lastInsertRowid);
      scrapesQueries.linkPost(scrapeId, postId);

      const webhookUrl = appSettingsQueries.get('sheets_webhook_url');
      if (webhookUrl) {
        const row = {
          id: scrapeId, scraped_at: new Date().toISOString(), project_name: '',
          username: postingAccount.username, source_username: keyword,
          source_url: topPost.url, text_content: scraped.textContent,
          first_comment: scraped.commentText || '', comment_links: scraped.commentLinks.join('\n'),
          media_urls: scraped.mediaUrls.join('\n'),
        };
        fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: [row] }) })
          .catch(err => console.warn('[Benchmarking] Sheets 자동 동기화 실패:', err));
      }

      if (tempPaths.length > 0) {
        const mediaPaths = moveToPostMedia(tempPaths, postId);
        postQueries.updateMediaPaths(postId, JSON.stringify(mediaPaths));
        scrapesQueries.updateMediaPaths(scrapeId, JSON.stringify(mediaPaths));
      }

      markScraped(targetUrl, topPost.url);
      addProgress(`  ✅${postLabel} 포스트 #${postId} 생성됨`, 'done');

      if (pi < selectedPosts.length - 1 && !shouldStopBenchmarking) {
        await sleep(randomInt(3000, 6000));
      }
    }

    progressDone = 1;
    projectBenchmarkingQueries.updateLastChecked(projectId);
    addProgress(`🎉 단일 대상 완료 — @${keyword}`, 'done');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addProgress(`❌ @${keyword} 오류: ${msg.slice(0, 120)}`, 'error');
    progressDone = 1;
  } finally {
    await ctx.close().catch(() => {});
    cleanupTempMedia();
    if (manageFlag) {
      isBenchmarkingRunning = false;
      shouldStopBenchmarking = false;
    }
  }
}

export async function runBenchmarking(): Promise<void> {
  if (isBenchmarkingRunning) return;
  isBenchmarkingRunning = true;
  shouldStopBenchmarking = false;
  benchmarkingStartedAt = Date.now();
  progressLog.length = 0;
  progressDone = 0;

  try {
    const enabledProjects = projectBenchmarkingQueries.getAllEnabled();
    if (enabledProjects.length === 0) return;
    addProgress(`전체 실행 시작 — ${enabledProjects.length}개 프로젝트`);
    for (const proj of enabledProjects) {
      await runBenchmarkingForProject(proj.project_id);
    }
  } finally {
    isBenchmarkingRunning = false;
  }
}

export function getBenchmarkingStatus(): { running: boolean; since: number } {
  return { running: isBenchmarkingRunning, since: benchmarkingStartedAt };
}
