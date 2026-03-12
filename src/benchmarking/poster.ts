/**
 * Threads 포스팅 + 미디어 첨부 + CTA 댓글 자동화
 * 기존 threadsPoster.ts와 동일한 browser-profile 패턴을 사용하되,
 * 파일 첨부(media upload) 기능이 추가된 별도 클래스입니다.
 */
import { chromium, BrowserContext, Locator, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { sleep, randomInt, humanTypeText, longDelay, mediumDelay } from '../human/humanBehavior';

export class BenchmarkingPoster {
  private readonly profilesBase = path.join(process.cwd(), 'data', 'browser-profiles');

  private removeSingletonLock(dir: string): void {
    for (const f of ['SingletonLock', 'SingletonSocket', 'lockfile']) {
      try { fs.rmSync(path.join(dir, f), { force: true, recursive: true }); } catch { /* ignore */ }
    }
  }

  private async openContext(profileDir: string): Promise<BrowserContext> {
    const userDataDir = path.join(this.profilesBase, profileDir);
    fs.mkdirSync(userDataDir, { recursive: true });
    this.removeSingletonLock(userDataDir);
    return chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280 + randomInt(-50, 50), height: 900 + randomInt(-30, 30) },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });
  }

  /** threadsPoster.ts 방식: 여러 Locator 팩토리 중 첫 번째로 visible한 것을 반환 */
  private async findFirst(
    locatorFns: Array<() => Locator>,
    timeoutMs = 8000,
  ): Promise<Locator | null> {
    for (const fn of locatorFns) {
      try {
        const loc = fn();
        await loc.first().waitFor({ state: 'visible', timeout: timeoutMs });
        return loc.first();
      } catch { /* try next */ }
    }
    return null;
  }

  /**
   * Posts content to Threads with optional media files, then adds a CTA comment.
   *
   * @param profileDir   - Browser profile directory name (e.g. "threads_myuser_1234")
   * @param content      - Main post text (AI-rewritten)
   * @param mediaPaths   - Absolute paths to downloaded media files (can be empty)
   * @param ctaComment   - CTA comment to post as a reply (can be empty string to skip)
   */
  async postWithMedia(
    profileDir: string,
    content: string,
    mediaPaths: string[],
    ctaComment: string,
  ): Promise<{ success: boolean; postUrl?: string; error?: string }> {
    const context = await this.openContext(profileDir);
    let page: Page | null = null;

    try {
      page = await context.newPage();

      // ── 1. Navigate to Threads home ─────────────────────────────────────
      console.log('[BenchmarkPoster] Threads 홈 이동...');
      await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await sleep(randomInt(1500, 2500));

      // 로그인 체크: DOM 기반 (threadsPoster.ts 방식)
      const profileLinkCount = await page.locator('a[href^="/@"]').count();
      if (profileLinkCount === 0) {
        throw new Error('로그인이 필요합니다. 해당 계정으로 먼저 로그인하세요.');
      }

      // ── 2. Open compose modal ───────────────────────────────────────────
      const createBtn = await this.findFirst([
        () => page!.getByRole('link', { name: /만들기/i }),
        () => page!.getByRole('button', { name: /만들기/i }),
        () => page!.locator('[aria-label*="만들기"], [aria-label*="New thread"], [aria-label*="Create"]'),
        () => page!.locator('[aria-label="새 게시물"], [aria-label="새 스레드"]'),
        () => page!.locator('[data-testid="new-post-button"]'),
      ]);
      if (!createBtn) throw new Error('"만들기" 버튼을 찾을 수 없습니다.');
      await createBtn.click();
      await mediumDelay();

      // Wait for the text editor inside the compose dialog
      const textArea = await this.findFirst([
        () => page!.locator('[role="dialog"] [contenteditable="true"][data-lexical-editor]').first(),
        () => page!.locator('[role="dialog"] [contenteditable="true"]').first(),
        () => page!.locator('[contenteditable="true"][data-lexical-editor]').first(),
        () => page!.getByRole('textbox').first(),
      ], 12000);
      if (!textArea) throw new Error('게시글 입력창을 찾을 수 없습니다.');

      // ── 3. Attach media files one by one (동영상 먼저, 이미지 나중) ────────
      const validPaths = mediaPaths.filter(p => fs.existsSync(p));
      if (validPaths.length > 0) {
        const isVideo = (p: string) => /\.(mp4|webm|mov|avi|mkv)$/i.test(p);
        const sortedPaths = [
          ...validPaths.filter(isVideo),
          ...validPaths.filter(p => !isVideo(p)),
        ];
        console.log(`[BenchmarkPoster] 미디어 첨부 시작: 총 ${sortedPaths.length}개 (동영상 ${sortedPaths.filter(isVideo).length}개 먼저)`);

        for (let i = 0; i < sortedPaths.length; i++) {
          const filePath = sortedPaths[i];
          const fileName = path.basename(filePath);
          console.log(`[BenchmarkPoster] ${i + 1}/${sortedPaths.length} 업로드 (${isVideo(filePath) ? '동영상' : '이미지'}): ${fileName}`);

          // 매 파일마다 file input을 새로 찾기 (이전 업로드 후 DOM이 바뀔 수 있음)
          let fileInput = await page!.$('input[type="file"]');

          if (!fileInput) {
            const mediaBtn = await this.findFirst([
              () => page!.locator('[aria-label*="사진"], [aria-label*="미디어"], [aria-label*="이미지"]'),
              () => page!.locator('[aria-label*="Photo"], [aria-label*="photo"], [aria-label*="Media"], [aria-label*="Image"]'),
              () => page!.locator('[data-testid*="media"], [data-testid*="photo"]'),
            ], 5000);

            if (mediaBtn) {
              await mediaBtn.click();
              await sleep(randomInt(500, 900));
              fileInput = await page!.$('input[type="file"]');
            }
          }

          if (!fileInput) {
            console.warn(`[BenchmarkPoster] 파일 입력 없음 → ${i + 1}번째 미디어 건너뜀`);
            continue;
          }

          // 한 번에 파일 하나만 업로드
          await fileInput.setInputFiles(filePath);

          // 업로드 완료 대기 (progress bar 사라질 때까지)
          await page!.waitForFunction(() => {
            return !document.querySelector(
              '[role="progressbar"], [aria-label*="업로드 중"], [aria-label*="uploading"], [aria-label*="Uploading"]'
            );
          }, { timeout: 120000 }).catch(() => {});

          await sleep(randomInt(1500, 2500));
          console.log(`[BenchmarkPoster] ${i + 1}번째 업로드 완료`);
        }

        console.log('[BenchmarkPoster] 모든 미디어 첨부 완료');
      }

      // ── 4. Type post content (human-like) ──────────────────────────────
      console.log('[BenchmarkPoster] 텍스트 입력 중...');
      await textArea.click();
      await sleep(randomInt(300, 600));
      await humanTypeText(page!, content);
      await sleep(randomInt(800, 1500));

      // ── 5. Submit ───────────────────────────────────────────────────────
      console.log('[BenchmarkPoster] [게시] 버튼 탐색 시작...');

      // 제출 전: 특정 에디터 DOM 요소 핸들 획득
      // ElementHandle = 특정 DOM 요소를 고정 추적 (Locator와 달리 새 요소로 교체되지 않음)
      const editorHandle = await page!.$('[data-lexical-editor][contenteditable="true"]');
      const editorWasPresent = editorHandle !== null;
      console.log(`[BenchmarkPoster] 제출 전 에디터: ${editorWasPresent ? '있음' : '없음'}`);

      // ── 전략 1: Playwright 셀렉터 기반 탐색 ──────────────────────────
      let postBtnLocator: Locator | null = null;
      for (const makeLocator of [
        () => page!.getByRole('dialog').getByRole('button', { name: /^게시$/ }).last(),
        () => page!.getByRole('dialog').getByRole('button', { name: /^Post$/ }).last(),
        () => page!.getByRole('button', { name: /^게시$/ }).last(),
        () => page!.getByRole('button', { name: /^Post$/ }).last(),
        () => page!.getByRole('button', { name: /게시/ }).last(),
        () => page!.locator('button:has-text("게시")').last(),
        () => page!.locator('button:has-text("Post")').last(),
        () => page!.locator('[aria-label="게시"]').last(),
        () => page!.locator('[aria-label="Post"]').last(),
        // role="button" 인 div/span도 포함 (Threads는 div 기반 버튼 사용 가능)
        () => page!.locator('[role="button"]:has-text("게시")').last(),
        () => page!.locator('[role="button"]:has-text("Post")').last(),
      ]) {
        try {
          const loc = makeLocator();
          await loc.waitFor({ state: 'visible', timeout: 3000 });
          const txt = await loc.textContent().catch(() => '?');
          console.log(`[BenchmarkPoster] 셀렉터로 발견: "${txt?.trim()}"`);
          postBtnLocator = loc;
          break;
        } catch { /* 다음 시도 */ }
      }

      // ── 전략 2: DOM 좌표 스캔 (화면에 보이는 요소를 직접 찾아 클릭) ──
      // 일반 포스팅과 버튼 구조가 다를 때 사용 (미디어 첨부 후 DOM 재구성)
      let clickedByCoords = false;
      if (!postBtnLocator) {
        console.log('[BenchmarkPoster] 셀렉터 실패 → DOM 좌표 스캔으로 전환...');

        // 현재 화면의 모든 "게시" 텍스트 요소 위치 수집
        // NOTE: evaluate() 콜백은 브라우저로 직렬화되므로 TypeScript 전용 문법 사용 불가
        // (타입 어노테이션, as 캐스팅, ?. 등 제거 → 순수 JS)
        const candidates = await page!.evaluate(function() {
          var results = [];
          var all = Array.from(document.querySelectorAll('*'));

          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            // 직접 텍스트만 확인 (자식 요소의 텍스트 제외)
            var directText = Array.from(el.childNodes)
              .filter(function(n) { return n.nodeType === 3; }) // Node.TEXT_NODE === 3
              .map(function(n) { return n.textContent ? n.textContent.trim() : ''; })
              .join('').trim();

            var ariaLabel = el.getAttribute('aria-label') || '';
            var isTargetText = directText === '게시' || directText === 'Post'
              || ariaLabel === '게시' || ariaLabel === 'Post';
            if (!isTargetText) continue;

            var rect = el.getBoundingClientRect();
            var style = window.getComputedStyle(el);
            var isVisible = style.display !== 'none'
              && style.visibility !== 'hidden'
              && parseFloat(style.opacity) > 0
              && rect.width > 0 && rect.height > 0;

            if (isVisible) {
              results.push({
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                tag: el.tagName,
                text: el.textContent ? el.textContent.trim() : '',
                role: el.getAttribute('role') || el.tagName,
              });
            }
          }
          return results;
        }) as Array<{ x: number; y: number; tag: string; text: string; role: string }>;

        console.log(`[BenchmarkPoster] DOM 스캔 결과 ${candidates.length}개:`, JSON.stringify(candidates));

        if (candidates.length > 0) {
          // 마지막 후보 = 일반적으로 메인 제출 버튼 (DOM 순서상 가장 나중에 등장)
          const target = candidates[candidates.length - 1];
          console.log(`[BenchmarkPoster] 좌표 클릭 → (${Math.round(target.x)}, ${Math.round(target.y)}) [${target.tag}] "${target.text}"`);
          await page!.mouse.click(target.x, target.y);
          clickedByCoords = true;
          console.log('[BenchmarkPoster] 좌표 클릭 완료');
        } else {
          throw new Error('"게시" 버튼을 찾을 수 없습니다 (셀렉터 + DOM 스캔 모두 실패). 로그인 여부와 화면 상태를 확인하세요.');
        }
      } else {
        // 셀렉터 발견 경로: 비활성화 해제 대기 후 클릭
        await page!.waitForFunction(function() {
          var all = Array.from(document.querySelectorAll('button, [role="button"]'));
          var targets = all.filter(function(el) {
            var txt = el.textContent ? el.textContent.trim() : '';
            return txt === '게시' || txt === 'Post' ||
              el.getAttribute('aria-label') === '게시' || el.getAttribute('aria-label') === 'Post';
          });
          if (targets.length === 0) return true;
          var last = targets[targets.length - 1] as HTMLButtonElement;
          return !last.disabled && last.getAttribute('aria-disabled') !== 'true';
        }, { timeout: 15000 }).catch(() => {});

        await postBtnLocator.scrollIntoViewIfNeeded();
        await sleep(randomInt(400, 700));
        await postBtnLocator.click();
        console.log('[BenchmarkPoster] [게시] 클릭 완료');
      }

      // ── 게시 성공 확인 ────────────────────────────────────────────────
      // ElementHandle(특정 DOM 요소 고정 참조)로 확인 → 새 에디터 생성 시 오탐 방지
      // Locator는 새 [data-lexical-editor]가 생기면(댓글창 등) 거기 바인딩되어 오탐 발생
      console.log('[BenchmarkPoster] 게시 성공 여부 확인 중...');

      if (editorWasPresent && editorHandle) {
        // 특정 에디터가 사라지면(hidden/detached) = 모달 닫힘 = 게시 완료
        const confirmed = await editorHandle.waitForElementState('hidden', { timeout: 25000 })
          .then(() => { console.log('[BenchmarkPoster] 에디터 사라짐 → 게시 성공 확인'); return true; })
          .catch(() => false);

        if (!confirmed) {
          throw new Error('[게시] 클릭했으나 모달이 닫히지 않았습니다. 게시에 실패했을 수 있습니다.');
        }
      } else if (clickedByCoords) {
        // 좌표 클릭 후 성공 확인: 5초 대기 후 에디터가 없으면 성공
        await sleep(5000);
        const editorGone = await page!.$('[data-lexical-editor][contenteditable="true"]')
          .then(el => el === null)
          .catch(() => true);
        if (!editorGone) {
          throw new Error('[게시] 좌표 클릭 후 모달이 닫히지 않았습니다. 게시에 실패했을 수 있습니다.');
        }
        console.log('[BenchmarkPoster] 좌표 클릭 후 에디터 사라짐 → 게시 성공');
      } else {
        await sleep(5000);
      }
      await longDelay();

      // ── 6. Retrieve post URL ─────────────────────────────────────────────
      const postUrl = await this.getPostUrl(page!);
      console.log(`[BenchmarkPoster] 포스팅 완료: ${postUrl || '(URL 확보 실패)'}`);

      // ── 7. Add CTA comment ───────────────────────────────────────────────
      if (ctaComment.trim() && postUrl) {
        await sleep(randomInt(3000, 6000));
        await this.addCtaComment(page!, postUrl, ctaComment.trim());
      }

      return { success: true, postUrl };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BenchmarkPoster] 오류: ${msg}`);
      return { success: false, error: msg };
    } finally {
      if (page) await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  /** 게시 후 포스트 URL 획득 (threadsPoster.ts의 getPostUrlAfterPublish와 동일한 로직) */
  private async getPostUrl(page: Page): Promise<string> {
    // Option A: 성공 토스트의 "보기" 링크 클릭 → 포스트 URL
    try {
      const viewLink = await this.findFirst([
        () => page.getByRole('link', { name: /보기|View/i }),
        () => page.locator('a:has-text("보기"), a:has-text("View")'),
      ], 8000);

      if (viewLink) {
        const href = await viewLink.getAttribute('href').catch(() => null);
        console.log('[BenchmarkPoster] [보기] 링크 발견:', href);
        await viewLink.click();
        await mediumDelay();
        const curUrl = page.url();
        if (curUrl.includes('/post/')) return curUrl;
        if (href) return href.startsWith('http') ? href : `https://www.threads.net${href}`;
      }
    } catch { /* 토스트 없음 */ }

    // Option B: 현재 URL이 포스트 페이지인 경우
    if (page.url().includes('/post/')) return page.url();

    // Option C: 프로필 페이지로 이동 후 첫 번째 포스트 링크 (가장 최근 포스트)
    try {
      const profileHref = await page.evaluate(function() {
        var links = Array.from(document.querySelectorAll('a[href^="/@"]'));
        return links.length > 0 ? (links[0] as HTMLAnchorElement).href : null;
      });
      if (profileHref) {
        await page.goto(profileHref, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await sleep(randomInt(2000, 3000));
        const postHref = await page.evaluate(function() {
          var links = Array.from(document.querySelectorAll('a[href*="/post/"]'));
          var clean = links.filter(function(a) {
            return /\/@[^/]+\/post\/[A-Za-z0-9_-]+$/.test((a as HTMLAnchorElement).href);
          });
          return clean.length > 0 ? (clean[0] as HTMLAnchorElement).href : '';
        });
        if (postHref) return postHref;
      }
    } catch { /* ignore */ }

    return '';
  }

  /**
   * 미디어가 첨부된 포스트를 Threads 네이티브 예약 기능으로 예약합니다.
   * postWithMedia()와 동일하게 미디어를 첨부하고 텍스트를 입력하되,
   * 마지막에 즉시 게시하지 않고 ⋯ → 예약 → 날짜/시간 설정 → 완료 → 예약 플로우를 사용합니다.
   */
  async scheduleWithMedia(
    profileDir: string,
    content: string,
    mediaPaths: string[],
    ctaComment: string,
    scheduledTime: Date,
  ): Promise<{ success: boolean; error?: string }> {
    const context = await this.openContext(profileDir);
    let page: Page | null = null;

    try {
      page = await context.newPage();

      console.log('[BenchmarkPoster] 네이티브 예약 시작: Threads 홈 이동...');
      await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await sleep(randomInt(1500, 2500));

      const profileLinkCount = await page.locator('a[href^="/@"]').count();
      if (profileLinkCount === 0) {
        throw new Error('로그인이 필요합니다. 해당 계정으로 먼저 로그인하세요.');
      }

      // 예약 시간 최소 15분 미래로 보정
      const now = new Date();
      const minMs = 15 * 60 * 1000;
      const targetTime = scheduledTime.getTime() - now.getTime() < minMs
        ? new Date(now.getTime() + minMs)
        : scheduledTime;
      console.log(`[BenchmarkPoster] 예약 목표: ${targetTime.toLocaleString('ko-KR')}`);

      // ── compose 모달 열기 ──────────────────────────────────────────────────
      const createBtn = await this.findFirst([
        () => page!.getByRole('link', { name: /만들기/i }),
        () => page!.getByRole('button', { name: /만들기/i }),
        () => page!.locator('[aria-label*="만들기"], [aria-label*="New thread"], [aria-label*="Create"]'),
        () => page!.locator('[aria-label="새 게시물"], [aria-label="새 스레드"]'),
      ]);
      if (!createBtn) throw new Error('"만들기" 버튼을 찾을 수 없습니다.');
      await createBtn.click();
      await mediumDelay();

      const textArea = await this.findFirst([
        () => page!.locator('[role="dialog"] [contenteditable="true"][data-lexical-editor]').first(),
        () => page!.locator('[role="dialog"] [contenteditable="true"]').first(),
        () => page!.locator('[contenteditable="true"][data-lexical-editor]').first(),
        () => page!.getByRole('textbox').first(),
      ], 12000);
      if (!textArea) throw new Error('게시글 입력창을 찾을 수 없습니다.');

      // ── 미디어 첨부 ──────────────────────────────────────────────────────
      const validPaths = mediaPaths.filter(p => fs.existsSync(p));
      if (validPaths.length > 0) {
        const isVideo = (p: string) => /\.(mp4|webm|mov|avi|mkv)$/i.test(p);
        const sortedPaths = [
          ...validPaths.filter(isVideo),
          ...validPaths.filter(p => !isVideo(p)),
        ];
        console.log(`[BenchmarkPoster] 미디어 첨부: ${sortedPaths.length}개`);

        for (let i = 0; i < sortedPaths.length; i++) {
          const filePath = sortedPaths[i];
          let fileInput = await page!.$('input[type="file"]');
          if (!fileInput) {
            const mediaBtn = await this.findFirst([
              () => page!.locator('[aria-label*="사진"], [aria-label*="미디어"], [aria-label*="이미지"]'),
              () => page!.locator('[aria-label*="Photo"], [aria-label*="Media"], [aria-label*="Image"]'),
            ], 5000);
            if (mediaBtn) {
              await mediaBtn.click();
              await sleep(randomInt(500, 900));
              fileInput = await page!.$('input[type="file"]');
            }
          }
          if (!fileInput) { console.warn(`[BenchmarkPoster] 파일입력 없음 → ${i + 1}번 건너뜀`); continue; }
          await fileInput.setInputFiles(filePath);
          await page!.waitForFunction(() => {
            return !document.querySelector('[role="progressbar"], [aria-label*="업로드 중"]');
          }, { timeout: 120000 }).catch(() => {});
          await sleep(randomInt(1500, 2500));
        }
      }

      // ── 텍스트 입력 ──────────────────────────────────────────────────────
      await textArea.click();
      await sleep(randomInt(300, 600));
      await humanTypeText(page!, content);
      await sleep(randomInt(800, 1500));

      // ── 댓글을 두 번째 스레드로 추가 ─────────────────────────────────────
      if (ctaComment.trim()) {
        await this.addThreadReplyInCompose(page!, ctaComment.trim());
      }

      // ── ⋯ 메뉴 → "예약" ─────────────────────────────────────────────────
      const moreBtn = await this.findFirst([
        () => page!.locator('[role="dialog"]').getByRole('button', { name: /더 보기|더보기/i }),
        () => page!.locator('[role="dialog"] button[aria-label*="더 보기"]'),
        () => page!.locator('[role="dialog"] [aria-label*="More"]'),
        () => page!.getByRole('button', { name: /더 보기|더보기/i }),
        () => page!.locator('button[aria-label*="더 보기"]'),
      ], 8000);
      if (!moreBtn) throw new Error('⋯ 메뉴를 찾을 수 없습니다.');
      await moreBtn.click();
      await sleep(randomInt(500, 900));

      const scheduleOpt = await this.findFirst([
        () => page!.getByRole('menuitem', { name: /예약/i }),
        () => page!.getByRole('option', { name: /예약/i }),
        () => page!.locator('[role="menuitem"]:has-text("예약")'),
        () => page!.locator('[role="listitem"]:has-text("예약")'),
        () => page!.locator('[role="menu"] button:has-text("예약")').first(),
        () => page!.locator('button:has-text("예약")').first(),
        () => page!.locator('[role="button"]:has-text("예약")').first(),
      ], 5000);

      if (!scheduleOpt) {
        // DOM 좌표 스캔 fallback
        console.log('[BenchmarkPoster] 셀렉터 실패 → DOM 좌표 스캔으로 "예약" 탐색...');
        const candidates = await page!.evaluate(function() {
          var results: { x: number; y: number }[] = [];
          var all = Array.from(document.querySelectorAll('*'));
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var directText = Array.from(el.childNodes)
              .filter(function(n) { return n.nodeType === 3; })
              .map(function(n) { return n.textContent ? n.textContent.trim() : ''; })
              .join('').trim();
            if (directText !== '예약' && directText !== 'Schedule') continue;
            var rect = el.getBoundingClientRect();
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (rect.width > 0 && rect.height > 0) {
              results.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
            }
          }
          return results;
        });
        if (candidates.length > 0) {
          const t = candidates[0];
          console.log(`[BenchmarkPoster] DOM 스캔 "예약" 발견: (${Math.round(t.x)}, ${Math.round(t.y)})`);
          await page!.mouse.click(t.x, t.y);
          await mediumDelay();
        } else {
          throw new Error('"예약" 메뉴를 찾을 수 없습니다. 미디어 첨부 후 UI가 변경되었을 수 있습니다.');
        }
      } else {
        await scheduleOpt.click();
        await mediumDelay();
      }

      // ── 날짜/시간 설정 ───────────────────────────────────────────────────
      const year = targetTime.getFullYear();
      const month = targetTime.getMonth() + 1;
      const day = targetTime.getDate();
      const hours = targetTime.getHours();
      const minutes = targetTime.getMinutes();
      const isPM = hours >= 12;
      const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;

      const dateInput = await page!.$('input[type="date"]');
      if (dateInput) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        await dateInput.fill(dateStr);
        await page!.keyboard.press('Tab');
        await sleep(randomInt(300, 600));
      }

      const timeInput = await page!.$('input[type="time"]');
      if (timeInput) {
        await timeInput.fill(`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`);
        await page!.keyboard.press('Tab');
        await sleep(randomInt(300, 600));
      } else {
        // 커스텀 피커
        const ampmSel = await page!.$('select[aria-label*="오전"], select[aria-label*="오후"], select[aria-label*="AM"]');
        if (ampmSel) { await ampmSel.selectOption(isPM ? { label: '오후' } : { label: '오전' }); await sleep(300); }

        const hourSel = await page!.$('select[aria-label*="시"], select[aria-label*="hour"]');
        if (hourSel) {
          try { await hourSel.selectOption(String(hour12)); } catch { try { await hourSel.selectOption(String(hours)); } catch { /* ignore */ } }
          await sleep(300);
        }

        const minuteSel = await page!.$('select[aria-label*="분"], select[aria-label*="minute"]');
        if (minuteSel) {
          const opts = await minuteSel.$$('option');
          let bestVal = String(minutes); let bestDiff = Infinity;
          for (const opt of opts) {
            const v = await opt.getAttribute('value');
            if (v !== null) { const d = Math.abs(parseInt(v, 10) - minutes); if (d < bestDiff) { bestDiff = d; bestVal = v; } }
          }
          await minuteSel.selectOption(bestVal);
          await sleep(300);
        }

        if (!hourSel && !minuteSel) {
          const numInputs = await page!.$$('input[type="number"], input[inputmode="numeric"], [role="spinbutton"]');
          if (numInputs.length >= 1) { await numInputs[0].click(); await page!.keyboard.press('Control+a'); await page!.keyboard.type(String(hour12).padStart(2,'0')); await sleep(300); }
          if (numInputs.length >= 2) { await numInputs[1].click(); await page!.keyboard.press('Control+a'); await page!.keyboard.type(String(minutes).padStart(2,'0')); await sleep(300); }
        }
      }

      // ── 완료 → 예약 클릭 ─────────────────────────────────────────────────
      const doneBtn = await this.findFirst([
        () => page!.getByRole('button', { name: /^완료$|^Done$/i }),
        () => page!.locator('button:has-text("완료")').last(),
      ], 8000);
      if (doneBtn) { await doneBtn.click(); await mediumDelay(); }

      const scheduleBtn = await this.findFirst([
        () => page!.locator('[role="dialog"]').getByRole('button', { name: /^예약$/ }),
        () => page!.getByRole('button', { name: /^예약$/ }),
        () => page!.locator('[role="dialog"] button:has-text("예약")').last(),
      ], 8000);
      if (!scheduleBtn) throw new Error('"예약" 최종 버튼을 찾을 수 없습니다.');
      await scheduleBtn.click();

      await page!.waitForFunction(function() {
        return !document.querySelector('[data-lexical-editor][contenteditable="true"]');
      }, { timeout: 20000 }).catch(() => {});
      await mediumDelay();

      console.log(`[BenchmarkPoster] 예약 완료 ✅ ${targetTime.toLocaleString('ko-KR')}`);
      return { success: true };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BenchmarkPoster] 예약 오류: ${msg}`);
      return { success: false, error: msg };
    } finally {
      if (page) await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  /**
   * 이미 열려 있는 컨텍스트/페이지를 사용해 미디어 첨부 포스트를 예약합니다.
   * 배치 스케줄러가 하나의 브라우저를 여러 포스트에 재사용할 때 호출합니다.
   * 호출 전 page는 https://www.threads.net에 있어야 합니다.
   */
  async scheduleWithMediaOnPage(
    page: Page,
    content: string,
    mediaPaths: string[],
    ctaComment: string,
    scheduledTime: Date,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // 홈으로 이동 (이전 작업 후 다른 URL에 있을 수 있음)
      if (!page.url().startsWith('https://www.threads.net')) {
        await page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await sleep(randomInt(1000, 2000));
      }

      const now = new Date();
      const minMs = 15 * 60 * 1000;
      const targetTime = scheduledTime.getTime() - now.getTime() < minMs
        ? new Date(now.getTime() + minMs)
        : scheduledTime;
      console.log(`[BenchmarkPoster] 페이지 예약: ${targetTime.toLocaleString('ko-KR')}`);

      // compose 모달 열기
      const createBtn = await this.findFirst([
        () => page.getByRole('link', { name: /만들기/i }),
        () => page.getByRole('button', { name: /만들기/i }),
        () => page.locator('[aria-label*="만들기"], [aria-label*="New thread"], [aria-label*="Create"]'),
        () => page.locator('[aria-label="새 게시물"], [aria-label="새 스레드"]'),
      ]);
      if (!createBtn) throw new Error('"만들기" 버튼을 찾을 수 없습니다.');
      await createBtn.click();
      await mediumDelay();

      const textArea = await this.findFirst([
        () => page.locator('[role="dialog"] [contenteditable="true"][data-lexical-editor]').first(),
        () => page.locator('[role="dialog"] [contenteditable="true"]').first(),
        () => page.locator('[contenteditable="true"][data-lexical-editor]').first(),
        () => page.getByRole('textbox').first(),
      ], 12000);
      if (!textArea) throw new Error('게시글 입력창을 찾을 수 없습니다.');

      // 미디어 첨부
      const validPaths = mediaPaths.filter(p => fs.existsSync(p));
      if (validPaths.length > 0) {
        const isVideo = (p: string) => /\.(mp4|webm|mov|avi|mkv)$/i.test(p);
        const sortedPaths = [
          ...validPaths.filter(isVideo),
          ...validPaths.filter(p => !isVideo(p)),
        ];
        for (let i = 0; i < sortedPaths.length; i++) {
          let fileInput = await page.$('input[type="file"]');
          if (!fileInput) {
            const mediaBtn = await this.findFirst([
              () => page.locator('[aria-label*="사진"], [aria-label*="미디어"], [aria-label*="이미지"]'),
              () => page.locator('[aria-label*="Photo"], [aria-label*="Media"], [aria-label*="Image"]'),
            ], 5000);
            if (mediaBtn) {
              await mediaBtn.click();
              await sleep(randomInt(500, 900));
              fileInput = await page.$('input[type="file"]');
            }
          }
          if (!fileInput) continue;
          await fileInput.setInputFiles(sortedPaths[i]);
          await page.waitForFunction(() => {
            return !document.querySelector('[role="progressbar"], [aria-label*="업로드 중"]');
          }, { timeout: 120000 }).catch(() => {});
          await sleep(randomInt(1500, 2500));
        }
      }

      // 텍스트 입력
      await textArea.click();
      await sleep(randomInt(300, 600));
      await humanTypeText(page, content);
      await sleep(randomInt(800, 1500));

      // 댓글 스레드 추가
      if (ctaComment.trim()) {
        await this.addThreadReplyInCompose(page, ctaComment.trim());
      }

      // ⋯ 메뉴 → 예약
      const moreBtn = await this.findFirst([
        () => page.locator('[role="dialog"]').getByRole('button', { name: /더 보기|더보기/i }),
        () => page.locator('[role="dialog"] button[aria-label*="더 보기"]'),
        () => page.locator('[role="dialog"] [aria-label*="More"]'),
        () => page.getByRole('button', { name: /더 보기|더보기/i }),
        () => page.locator('button[aria-label*="더 보기"]'),
      ], 8000);
      if (!moreBtn) throw new Error('⋯ 메뉴를 찾을 수 없습니다.');
      await moreBtn.click();
      await sleep(randomInt(500, 900));

      const scheduleOpt = await this.findFirst([
        () => page.getByRole('menuitem', { name: /예약/i }),
        () => page.getByRole('option', { name: /예약/i }),
        () => page.locator('[role="menuitem"]:has-text("예약")'),
        () => page.locator('[role="listitem"]:has-text("예약")'),
        () => page.locator('[role="menu"] button:has-text("예약")').first(),
        () => page.locator('button:has-text("예약")').first(),
        () => page.locator('[role="button"]:has-text("예약")').first(),
      ], 5000);

      if (!scheduleOpt) {
        const candidates = await page.evaluate(function() {
          var results: { x: number; y: number }[] = [];
          var all = Array.from(document.querySelectorAll('*'));
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var directText = Array.from(el.childNodes)
              .filter(function(n) { return n.nodeType === 3; })
              .map(function(n) { return n.textContent ? n.textContent.trim() : ''; })
              .join('').trim();
            if (directText !== '예약' && directText !== 'Schedule') continue;
            var rect = el.getBoundingClientRect();
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (rect.width > 0 && rect.height > 0) {
              results.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
            }
          }
          return results;
        });
        if (candidates.length > 0) {
          await page.mouse.click(candidates[0].x, candidates[0].y);
          await mediumDelay();
        } else {
          throw new Error('"예약" 메뉴를 찾을 수 없습니다.');
        }
      } else {
        await scheduleOpt.click();
        await mediumDelay();
      }

      // 날짜/시간 설정
      const year = targetTime.getFullYear();
      const month = targetTime.getMonth() + 1;
      const day = targetTime.getDate();
      const hours = targetTime.getHours();
      const minutes = targetTime.getMinutes();
      const isPM = hours >= 12;
      const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;

      const dateInput = await page.$('input[type="date"]');
      if (dateInput) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        await dateInput.fill(dateStr);
        await page.keyboard.press('Tab');
        await sleep(randomInt(300, 600));
      }

      const timeInput = await page.$('input[type="time"]');
      if (timeInput) {
        await timeInput.fill(`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`);
        await page.keyboard.press('Tab');
        await sleep(randomInt(300, 600));
      } else {
        const ampmSel = await page.$('select[aria-label*="오전"], select[aria-label*="오후"], select[aria-label*="AM"]');
        if (ampmSel) { await ampmSel.selectOption(isPM ? { label: '오후' } : { label: '오전' }); await sleep(300); }
        const hourSel = await page.$('select[aria-label*="시"], select[aria-label*="hour"]');
        if (hourSel) {
          try { await hourSel.selectOption(String(hour12)); } catch { try { await hourSel.selectOption(String(hours)); } catch { /* ignore */ } }
          await sleep(300);
        }
        const minuteSel = await page.$('select[aria-label*="분"], select[aria-label*="minute"]');
        if (minuteSel) {
          const opts = await minuteSel.$$('option');
          let bestVal = String(minutes); let bestDiff = Infinity;
          for (const opt of opts) {
            const v = await opt.getAttribute('value');
            if (v !== null) { const d = Math.abs(parseInt(v, 10) - minutes); if (d < bestDiff) { bestDiff = d; bestVal = v; } }
          }
          await minuteSel.selectOption(bestVal);
          await sleep(300);
        }
        if (!hourSel && !minuteSel) {
          const numInputs = await page.$$('input[type="number"], input[inputmode="numeric"], [role="spinbutton"]');
          if (numInputs.length >= 1) { await numInputs[0].click(); await page.keyboard.press('Control+a'); await page.keyboard.type(String(hour12).padStart(2,'0')); await sleep(300); }
          if (numInputs.length >= 2) { await numInputs[1].click(); await page.keyboard.press('Control+a'); await page.keyboard.type(String(minutes).padStart(2,'0')); await sleep(300); }
        }
      }

      // 완료 → 예약
      const doneBtn = await this.findFirst([
        () => page.getByRole('button', { name: /^완료$|^Done$/i }),
        () => page.locator('button:has-text("완료")').last(),
      ], 8000);
      if (doneBtn) { await doneBtn.click(); await mediumDelay(); }

      const scheduleBtn = await this.findFirst([
        () => page.locator('[role="dialog"]').getByRole('button', { name: /^예약$/ }),
        () => page.getByRole('button', { name: /^예약$/ }),
        () => page.locator('[role="dialog"] button:has-text("예약")').last(),
      ], 8000);
      if (!scheduleBtn) throw new Error('"예약" 최종 버튼을 찾을 수 없습니다.');
      await scheduleBtn.click();

      await page.waitForFunction(function() {
        return !document.querySelector('[data-lexical-editor][contenteditable="true"]');
      }, { timeout: 20000 }).catch(() => {});
      await mediumDelay();

      console.log(`[BenchmarkPoster] 페이지 예약 완료 ✅ ${targetTime.toLocaleString('ko-KR')}`);
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BenchmarkPoster] 페이지 예약 오류: ${msg}`);
      return { success: false, error: msg };
    }
  }

  /** 작성 모달에서 두 번째 스레드 슬롯에 댓글 입력 (threadsPoster.ts와 동일한 로직) */
  private async addThreadReplyInCompose(page: Page, comment: string): Promise<void> {
    try {
      console.log('[BenchmarkPoster] 댓글 스레드 추가 중...');
      await sleep(randomInt(300, 600));

      // Threads 작성 모달 두 번째 슬롯 레이블: "스레드에 추가" (스크린샷 확인)
      // "이어서 작성"은 구버전 표기 → 둘 다 탐색

      // Case 1: 두 번째 슬롯이 이미 contenteditable로 렌더된 경우 → 직접 입력
      const existingSlot = await this.findFirst([
        () => page.locator('[contenteditable="true"][data-placeholder*="스레드에 추가"]'),
        () => page.locator('[contenteditable="true"][data-placeholder*="이어서"]'),
        () => page.locator('[contenteditable][data-placeholder*="스레드에 추가"]'),
        () => page.locator('[contenteditable][data-placeholder*="이어서"]'),
      ], 2000);

      if (existingSlot) {
        console.log('[BenchmarkPoster] 기존 댓글 슬롯 발견 → 직접 입력');
        await existingSlot.click();
        await sleep(randomInt(300, 500));
        await humanTypeText(page, comment);
        console.log('[BenchmarkPoster] 댓글 입력 완료 (기존 슬롯)');
        return;
      }

      // Case 2: "스레드에 추가" 클릭 영역으로 새 슬롯 활성화
      const beforeCount = await page.locator('[contenteditable="true"]').count();

      let clicked = false;
      const addBtn = await this.findFirst([
        () => page.getByText(/스레드에 추가/i).first(),
        () => page.getByRole('button', { name: /스레드에 추가|이어서 작성|이어서/i }),
        () => page.locator('[aria-label*="스레드에 추가"], [aria-label*="이어서 작성"]'),
        () => page.getByText(/이어서 작성/i).first(),
      ], 5000);

      if (addBtn) {
        await addBtn.click();
        await sleep(randomInt(400, 600));
        clicked = true;
      } else {
        // DOM 좌표 스캔 fallback
        console.log('[BenchmarkPoster] 버튼 탐색 실패 → DOM 스캔으로 "스레드에 추가" 탐색...');
        const found = await page.evaluate(function() {
          var KEYWORDS = ['스레드에 추가', '이어서 작성', 'Add to thread'];
          var all = Array.from(document.querySelectorAll('*'));
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var placeholder = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
            var directText = Array.from(el.childNodes)
              .filter(function(n) { return n.nodeType === 3; })
              .map(function(n) { return n.textContent ? n.textContent.trim() : ''; })
              .join('').trim();
            var isMatch = KEYWORDS.some(function(k) { return placeholder.includes(k) || directText.includes(k); });
            if (!isMatch) continue;
            var rect = el.getBoundingClientRect();
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, isEditable: el.getAttribute('contenteditable') !== null };
            }
          }
          return null;
        });

        if (!found) {
          console.log('[BenchmarkPoster] "스레드에 추가" 요소 없음 → 댓글 건너뜀');
          return;
        }

        await page.mouse.click(found.x, found.y);
        await sleep(randomInt(300, 500));

        if (found.isEditable) {
          await humanTypeText(page, comment);
          console.log('[BenchmarkPoster] 댓글 입력 완료 (DOM 스캔 → editable)');
          return;
        }
        clicked = true;
      }

      if (!clicked) return;

      await page.waitForFunction((count: number) => {
        return document.querySelectorAll('[contenteditable="true"]').length > count;
      }, beforeCount, { timeout: 5000 }).catch(() => {});
      await sleep(randomInt(200, 400));

      const afterCount = await page.locator('[contenteditable="true"]').count();
      if (afterCount <= beforeCount) {
        const fallback = await this.findFirst([
          () => page.locator('[contenteditable][data-placeholder*="스레드에 추가"]'),
          () => page.locator('[contenteditable][data-placeholder*="이어서"]'),
        ], 2000);
        if (fallback) {
          await fallback.click();
          await sleep(randomInt(300, 500));
          await humanTypeText(page, comment);
          console.log('[BenchmarkPoster] 댓글 입력 완료 (fallback 슬롯)');
        } else {
          console.log('[BenchmarkPoster] 댓글 슬롯 생성 실패 → 건너뜀');
        }
        return;
      }

      const replyInput = page.locator('[contenteditable="true"]').nth(afterCount - 1);
      await replyInput.click();
      await sleep(randomInt(300, 500));
      await humanTypeText(page, comment);
      console.log(`[BenchmarkPoster] 댓글 입력 완료 (슬롯 ${afterCount - 1}번)`);
    } catch (e) {
      console.log('[BenchmarkPoster] 댓글 추가 실패 (건너뜀):', e instanceof Error ? e.message : e);
    }
  }

  private async addCtaComment(page: Page, postUrl: string, comment: string): Promise<void> {
    try {
      console.log('[BenchmarkPoster] CTA 댓글 작성 중...');

      // 포스트 페이지로 이동 (아직 거기 없으면)
      if (!page.url().includes('/post/')) {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await mediumDelay();
      }

      // 답글 버튼 클릭 (threadsPoster.ts 방식)
      const replyBtn = await this.findFirst([
        () => page.getByRole('button', { name: /^답글$|^Reply$/i }).first(),
        () => page.locator('[aria-label*="답글"], [aria-label*="Reply"]').first(),
        () => page.getByText(/^답글$|^Reply$/i).first(),
      ]);
      if (!replyBtn) { console.warn('[BenchmarkPoster] 답글 버튼 없음 → CTA 생략'); return; }
      await replyBtn.click();
      await sleep(randomInt(800, 1400));

      // 답글 입력창 찾기
      const replyInput = await this.findFirst([
        () => page.locator('[role="dialog"] [contenteditable="true"]').last(),
        () => page.locator('[contenteditable="true"]').last(),
        () => page.getByRole('textbox').last(),
      ]);
      if (!replyInput) { console.warn('[BenchmarkPoster] 답글 입력창 없음 → CTA 생략'); return; }

      await replyInput.click();
      await sleep(randomInt(300, 600));
      await humanTypeText(page, comment);
      await sleep(randomInt(800, 1400));

      // 댓글 게시 버튼 (threadsPoster.ts와 동일하게 .last() 사용)
      const submitBtn = await this.findFirst([
        () => page.getByRole('button', { name: /^게시$/ }).last(),
        () => page.getByRole('button', { name: /^Post$/ }).last(),
      ]);
      if (submitBtn) {
        await submitBtn.click();
        await mediumDelay();
        console.log('[BenchmarkPoster] CTA 댓글 완료');
      } else {
        console.warn('[BenchmarkPoster] 댓글 게시 버튼 없음 → CTA 생략');
      }
    } catch (err) {
      console.error('[BenchmarkPoster] CTA 댓글 오류 (계속 진행):', err);
    }
  }
}

export const benchmarkingPoster = new BenchmarkingPoster();
