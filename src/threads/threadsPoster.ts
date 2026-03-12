import { chromium, BrowserContext, Page, Locator } from 'playwright';
import path from 'path';
import fs from 'fs';
import {
  mediumDelay, longDelay, shortDelay,
  sleep, randomInt, simulateReading, humanTypeText
} from '../human/humanBehavior';

const THREADS_URL = 'https://www.threads.net';

export interface PostResult {
  success: boolean;
  postUrl?: string;
  error?: string;
}

export class ThreadsPoster {
  private profilesBase: string;

  constructor() {
    this.profilesBase = path.join(process.cwd(), 'data', 'browser-profiles');
    if (!fs.existsSync(this.profilesBase)) {
      fs.mkdirSync(this.profilesBase, { recursive: true });
    }
  }

  private getProfileDir(profileDir: string): string {
    return path.join(this.profilesBase, profileDir);
  }

  // Windows에서 Chromium이 남긴 stale lock 파일 제거
  private removeSingletonLock(userDataDir: string): void {
    for (const lock of ['SingletonLock', 'SingletonSocket', 'lockfile']) {
      const lockPath = path.join(userDataDir, lock);
      try { fs.rmSync(lockPath, { force: true, recursive: true }); } catch { /* ignore */ }
    }
  }

  async openContext(profileDir: string): Promise<BrowserContext> {
    const userDataDir = this.getProfileDir(profileDir);
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });
    this.removeSingletonLock(userDataDir);

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1280 + randomInt(-50, 50), height: 900 + randomInt(-30, 30) },
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
    });

    return context;
  }

  // 본문에서 해시태그를 분리 (마지막 줄이 #태그 #태그... 형태이면 분리)
  private splitContentAndHashtags(content: string): { mainText: string; hashtags: string[] } {
    const lines = content.split('\n');
    const hashtags: string[] = [];
    let splitIndex = lines.length;

    // 끝에서부터 해시태그 줄 찾기
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line === '') continue;
      const words = line.split(/\s+/);
      if (words.length > 0 && words.every(w => w.startsWith('#') && w.length > 1)) {
        words.forEach(w => hashtags.unshift(w.replace(/^#/, '')));
        splitIndex = i;
      } else {
        break;
      }
    }

    const mainText = lines.slice(0, splitIndex).join('\n').trim();
    return { mainText: mainText || content.trim(), hashtags };
  }

  // ─── 메인 포스트 + 댓글 작성 ──────────────────────────────────────────────
  async post(
    accountProfileDir: string,
    mainContent: string,
    commentContent: string
  ): Promise<PostResult> {
    const context = await this.openContext(accountProfileDir);
    let page: Page | null = null;

    try {
      page = await context.newPage();

      console.log('[Threads] 홈 접속 중...');
      await page.goto(THREADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await mediumDelay();
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      // 로그인 여부 체크 (URL + DOM 이중 확인)
      const url = page.url();
      if (url.includes('/login') || url.includes('/accounts/login')) {
        throw new Error('Threads 로그인이 필요합니다. 먼저 "로그인 설정" 버튼으로 로그인하세요.');
      }
      // DOM 기반 확인: 프로필 링크가 없으면 미로그인 (홈URL 유지 + 로그인 모달 케이스 방어)
      const profileLinkCount = await page.locator('a[href^="/@"]').count();
      if (profileLinkCount === 0) {
        throw new Error('Threads 로그인이 필요합니다. 먼저 "로그인 설정" 버튼으로 로그인하세요.');
      }

      await simulateReading(page);

      // 본문과 해시태그 분리
      const { mainText, hashtags } = this.splitContentAndHashtags(mainContent);
      console.log(`[Threads] 본문 ${mainText.length}자, 해시태그 ${hashtags.length}개`);

      // 메인 포스트 작성
      console.log('[Threads] 메인 포스트 작성 중...');
      const postUrl = await this.createMainPost(page, mainText, hashtags);
      console.log('[Threads] 메인 포스트 완료:', postUrl);

      // 댓글 작성
      if (commentContent && commentContent.trim() && postUrl) {
        console.log('[Threads] 댓글 작성 중...');
        await longDelay();
        await this.addComment(page, postUrl, commentContent);
        console.log('[Threads] 댓글 완료');
      }

      return { success: true, postUrl };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[Threads] 오류:', msg);
      return { success: false, error: msg };
    } finally {
      if (page) await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  // ─── [만들기] 클릭 → 글 입력 → 주제추가 → [게시] → URL 획득 ──────────────
  private async createMainPost(page: Page, mainText: string, hashtags: string[]): Promise<string | undefined> {

    // ── Step 1: [만들기] 버튼 클릭 ──────────────────────────────────────────
    console.log('[Threads] [만들기] 버튼 클릭 중...');
    const createBtn = await this.findFirst([
      () => page.getByRole('link', { name: /만들기/i }),
      () => page.getByRole('button', { name: /만들기/i }),
      () => page.locator('[aria-label*="만들기"], [aria-label*="New thread"], [aria-label*="Create"]'),
      () => page.locator('a[href*="compose"], a[href*="create"]'),
      () => page.locator('svg[aria-label*="새"], svg[aria-label*="Create"]').locator('..'),
    ], 5000);

    if (!createBtn) throw new Error('[만들기] 버튼을 찾을 수 없습니다. 페이지 구조가 변경되었을 수 있습니다.');
    await createBtn.click();
    await mediumDelay();

    // ── Step 2: 텍스트 입력창 찾아서 글 입력 ────────────────────────────────
    console.log('[Threads] 텍스트 입력창에 글 입력 중...');
    const textInput = await this.findFirst([
      () => page.locator('[contenteditable="true"][data-lexical-editor]').first(),
      () => page.locator('[role="dialog"] [contenteditable="true"]').first(),
      () => page.getByRole('textbox').first(),
      () => page.locator('[contenteditable="true"]').first(),
    ], 10000);

    if (!textInput) throw new Error('텍스트 입력창을 찾을 수 없습니다. [만들기] 버튼 클릭이 실패했을 수 있습니다.');

    await textInput.click();
    await shortDelay();
    // 사람처럼 글자 하나씩 타이핑 (밴 방지)
    await humanTypeText(page, mainText);

    // ── Step 3: 주제추가에 해시태그 입력 (있는 경우만) ───────────────────────
    if (hashtags.length > 0) {
      await this.addTopics(page, hashtags);
    }

    // ── Step 4: [게시] 버튼 클릭 ────────────────────────────────────────────
    console.log('[Threads] [게시] 버튼 클릭 중...');
    const postBtn = await this.findFirst([
      () => page.getByRole('button', { name: /^게시$/ }),
      () => page.getByRole('button', { name: /^Post$/ }),
      () => page.locator('button[data-testid*="post"], button[data-testid*="submit"]'),
    ], 8000);

    if (!postBtn) throw new Error('[게시] 버튼을 찾을 수 없습니다.');
    await postBtn.click();

    console.log('[Threads] 게시 완료 대기 중...');
    await longDelay();

    // ── Step 5: "게시되었습니다" 확인 후 [보기] 클릭 → 포스트 URL 획득 ──────
    const postUrl = await this.getPostUrlAfterPublish(page);
    return postUrl;
  }

  // ─── 주제추가에 해시태그 입력 ────────────────────────────────────────────
  private async addTopics(page: Page, hashtags: string[]): Promise<void> {
    try {
      console.log(`[Threads] 주제추가 중... (${hashtags.join(', ')})`);

      const topicsBtn = await this.findFirst([
        () => page.getByRole('button', { name: /주제 추가|Add topics?/i }),
        () => page.locator('[aria-label*="주제"], [aria-label*="topic"]'),
        () => page.getByText(/주제 추가|Add topics?/i),
      ], 5000);

      if (!topicsBtn) {
        console.log('[Threads] 주제추가 버튼 없음 - 건너뜀');
        return;
      }

      await topicsBtn.click();
      await shortDelay();

      // Threads는 최대 5개 주제 허용
      for (const tag of hashtags.slice(0, 5)) {
        const topicInput = await this.findFirst([
          () => page.locator('[placeholder*="주제"], [placeholder*="topic"], [placeholder*="Topic"]').last(),
          () => page.getByRole('textbox').last(),
        ], 3000);

        if (!topicInput) break;

        await topicInput.fill(tag);
        await sleep(600);

        // 자동완성 중 첫번째 항목 클릭 또는 Enter
        try {
          const suggestion = page.locator('[role="option"], [role="listitem"]').first();
          await suggestion.waitFor({ timeout: 1500 });
          await suggestion.click();
        } catch {
          await page.keyboard.press('Enter');
        }
        await shortDelay();
      }

      // 주제추가 완료 확인 버튼이 있으면 클릭
      try {
        const doneBtn = page.getByRole('button', { name: /완료|Done/i });
        await doneBtn.waitFor({ timeout: 2000 });
        await doneBtn.click();
        await shortDelay();
      } catch { /* 없으면 건너뜀 */ }

    } catch (e) {
      console.log('[Threads] 주제추가 실패 (건너뜀):', e instanceof Error ? e.message : e);
    }
  }

  // ─── 게시 후 URL 획득: "게시되었습니다" → [보기] 클릭 ────────────────────
  private async getPostUrlAfterPublish(page: Page): Promise<string | undefined> {
    // "게시되었습니다" 토스트에서 [보기] 링크 찾기
    try {
      const viewLink = await this.findFirst([
        () => page.getByRole('link', { name: /보기|View/i }),
        () => page.locator('a:has-text("보기"), a:has-text("View")'),
      ], 10000);

      if (viewLink) {
        const href = await viewLink.getAttribute('href').catch(() => null);
        console.log('[Threads] [보기] 링크 발견:', href);
        await viewLink.click();
        await mediumDelay();

        const currentUrl = page.url();
        if (currentUrl.includes('/post/')) return currentUrl;
        if (href) return href.startsWith('http') ? href : `https://www.threads.net${href}`;
      }
    } catch { /* 토스트 없음 */ }

    // 현재 URL이 포스트 URL인 경우
    const currentUrl = page.url();
    if (currentUrl.includes('/post/')) return currentUrl;

    // 피드에서 가장 최근 포스트 링크 찾기
    try {
      await page.waitForSelector('a[href*="/post/"]', { timeout: 5000 });
      const href = await page.locator('a[href*="/post/"]').first().getAttribute('href');
      return href ? `https://www.threads.net${href}` : undefined;
    } catch {
      return undefined;
    }
  }

  // ─── 댓글 작성: 포스트 페이지 → [답글] → 내용 입력 → [게시] ───────────────
  private async addComment(page: Page, postUrl: string, comment: string): Promise<void> {
    // 포스트 페이지로 이동 (아직 거기 없으면)
    if (!page.url().includes('/post/')) {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await mediumDelay();
    }
    await simulateReading(page);

    // ── [답글] 버튼 클릭 ────────────────────────────────────────────────────
    console.log('[Threads] [답글] 버튼 클릭 중...');
    const replyBtn = await this.findFirst([
      () => page.getByRole('button', { name: /^답글$|^Reply$/i }).first(),
      () => page.locator('[aria-label*="답글"], [aria-label*="Reply"]').first(),
      () => page.getByText(/^답글$|^Reply$/i).first(),
    ], 10000);

    if (replyBtn) {
      await replyBtn.click();
      await shortDelay();
    }

    // ── 댓글 입력창 찾아서 내용 입력 ──────────────────────────────────────
    console.log('[Threads] 댓글 내용 입력 중...');
    const commentInput = await this.findFirst([
      () => page.locator('[role="dialog"] [contenteditable="true"]').last(),
      () => page.locator('[contenteditable="true"]').last(),
      () => page.getByRole('textbox').last(),
    ], 8000);

    if (!commentInput) throw new Error('댓글 입력창을 찾을 수 없습니다.');

    await commentInput.click();
    await shortDelay();
    // 사람처럼 글자 하나씩 타이핑 (밴 방지)
    await humanTypeText(page, comment);

    // ── 댓글 [게시] 버튼 클릭 ───────────────────────────────────────────────
    const submitBtn = await this.findFirst([
      () => page.getByRole('button', { name: /^게시$/ }).last(),
      () => page.getByRole('button', { name: /^Post$/ }).last(),
    ], 5000);

    if (!submitBtn) throw new Error('댓글 게시 버튼을 찾을 수 없습니다.');
    await submitBtn.click();
    await mediumDelay();
  }

  // ─── 공통: 여러 로케이터 중 첫번째로 찾은 요소 반환 ──────────────────────
  private async findFirst(
    locatorFns: Array<() => Locator>,
    timeoutMs = 5000
  ): Promise<Locator | null> {
    for (const fn of locatorFns) {
      try {
        const locator = fn();
        await locator.first().waitFor({ state: 'visible', timeout: timeoutMs });
        return locator.first();
      } catch { /* 다음 시도 */ }
    }
    return null;
  }

  // ─── 현재 로그인된 Threads 유저네임 반환 (없으면 null) ──────────────────
  private async getCurrentUsername(page: Page): Promise<string | null> {
    try {
      // 사이드바/하단 내비에 /@username 형태의 프로필 링크가 있음
      const profileLinks = page.locator('a[href^="/@"]');
      const count = await profileLinks.count();
      if (count > 0) {
        const href = await profileLinks.first().getAttribute('href');
        if (href) {
          const match = href.match(/^\/@([^/?]+)/);
          if (match) return match[1].toLowerCase();
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  // ─── Threads 로그아웃 ─────────────────────────────────────────────────────
  private async logoutThreads(page: Page): Promise<void> {
    try {
      await page.goto(`${THREADS_URL}/logout/`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(2000);
    } catch { /* ignore */ }
  }

  // ─── Threads 네이티브 예약 포스팅 ─────────────────────────────────────────
  /**
   * Threads 네이티브 예약 기능을 사용해 포스트를 예약 등록합니다.
   * 컴퓨터가 꺼져 있어도 Threads 서버가 지정된 시간에 자동 게시합니다.
   * 워크플로우: (+)버튼 → 본문 → 댓글 → ⋯ → 예약 → 날짜/시간 → 완료 → 예약
   */
  async schedule(
    accountProfileDir: string,
    mainContent: string,
    commentContent: string,
    scheduledTime: Date,
  ): Promise<PostResult> {
    const context = await this.openContext(accountProfileDir);
    let page: Page | null = null;
    try {
      page = await context.newPage();

      console.log('[Threads] 예약 포스팅: 홈 접속 중...');
      await page.goto(THREADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await mediumDelay();
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

      const url = page.url();
      if (url.includes('/login') || url.includes('/accounts/login')) {
        throw new Error('Threads 로그인이 필요합니다. 먼저 "로그인 설정" 버튼으로 로그인하세요.');
      }
      const profileLinkCount = await page.locator('a[href^="/@"]').count();
      if (profileLinkCount === 0) {
        throw new Error('Threads 로그인이 필요합니다. 먼저 "로그인 설정" 버튼으로 로그인하세요.');
      }

      await simulateReading(page);

      // 예약 시간이 너무 가까우면 15분 후로 자동 조정 (Threads 최소 예약 시간)
      const now = new Date();
      const minMs = 15 * 60 * 1000;
      const targetTime = scheduledTime.getTime() - now.getTime() < minMs
        ? new Date(now.getTime() + minMs)
        : scheduledTime;
      console.log(`[Threads] 예약 목표 시간: ${targetTime.toLocaleString('ko-KR')}`);

      const { mainText, hashtags } = this.splitContentAndHashtags(mainContent);

      // ── Step 1: [만들기] 버튼 클릭 ──────────────────────────────────────
      const createBtn = await this.findFirst([
        () => page!.getByRole('link', { name: /만들기/i }),
        () => page!.getByRole('button', { name: /만들기/i }),
        () => page!.locator('[aria-label*="만들기"], [aria-label*="New thread"], [aria-label*="Create"]'),
        () => page!.locator('a[href*="compose"], a[href*="create"]'),
        () => page!.locator('svg[aria-label*="새"], svg[aria-label*="Create"]').locator('..'),
      ], 5000);
      if (!createBtn) throw new Error('[만들기] 버튼을 찾을 수 없습니다.');
      await createBtn.click();
      await mediumDelay();

      // ── Step 2: 본문 입력 ────────────────────────────────────────────────
      const textInput = await this.findFirst([
        () => page!.locator('[contenteditable="true"][data-lexical-editor]').first(),
        () => page!.locator('[role="dialog"] [contenteditable="true"]').first(),
        () => page!.getByRole('textbox').first(),
        () => page!.locator('[contenteditable="true"]').first(),
      ], 10000);
      if (!textInput) throw new Error('텍스트 입력창을 찾을 수 없습니다.');

      await textInput.click();
      await shortDelay();
      await humanTypeText(page, mainText);

      if (hashtags.length > 0) await this.addTopics(page, hashtags);

      // ── Step 3: 댓글을 두 번째 스레드로 추가 ────────────────────────────
      if (commentContent && commentContent.trim()) {
        await this.addThreadReplyInCompose(page, commentContent);
      }

      // ── Step 4: ⋯ 메뉴 → "예약" 클릭 ───────────────────────────────────
      await this.openScheduleMenu(page);

      // ── Step 5: 날짜/시간 설정 ───────────────────────────────────────────
      await this.setScheduleDateTime(page, targetTime);

      // ── Step 6: 완료 → 예약 버튼 클릭 ───────────────────────────────────
      await this.confirmSchedule(page);

      console.log(`[Threads] 예약 완료 ✅ ${targetTime.toLocaleString('ko-KR')}`);
      return { success: true };

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[Threads] 예약 오류:', msg);
      return { success: false, error: msg };
    } finally {
      if (page) await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  /** 작성 모달에서 두 번째 스레드 슬롯에 댓글 입력 */
  private async addThreadReplyInCompose(page: Page, comment: string): Promise<void> {
    try {
      console.log('[Threads] 댓글 스레드 추가 중...');
      await shortDelay();

      // Threads 작성 모달 두 번째 슬롯은 "스레드에 추가" 텍스트로 표시됨 (스크린샷 확인)
      // "이어서 작성"은 구버전 표기이므로 둘 다 탐색

      // ── Case 1: 두 번째 슬롯이 이미 contenteditable로 렌더된 경우 → 직접 입력 ──
      const existingSlot = await this.findFirst([
        () => page.locator('[contenteditable="true"][data-placeholder*="스레드에 추가"]'),
        () => page.locator('[contenteditable="true"][data-placeholder*="이어서"]'),
        () => page.locator('[contenteditable][data-placeholder*="스레드에 추가"]'),
        () => page.locator('[contenteditable][data-placeholder*="이어서"]'),
      ], 2000);

      if (existingSlot) {
        console.log('[Threads] 기존 댓글 슬롯(contenteditable) 발견 → 직접 입력');
        await existingSlot.click();
        await shortDelay();
        await humanTypeText(page, comment);
        console.log('[Threads] 댓글 입력 완료 (기존 슬롯)');
        return;
      }

      // ── Case 2: "스레드에 추가" / "이어서 작성" 클릭 영역으로 새 슬롯 활성화 ──
      const beforeCount = await page.locator('[contenteditable="true"]').count();
      console.log(`[Threads] 현재 입력창 수: ${beforeCount}`);

      let clicked = false;
      const addBtn = await this.findFirst([
        () => page.getByText(/스레드에 추가/i).first(),
        () => page.getByRole('button', { name: /스레드에 추가|이어서 작성|이어서/i }),
        () => page.locator('[aria-label*="스레드에 추가"], [aria-label*="이어서 작성"]'),
        () => page.getByText(/이어서 작성/i).first(),
      ], 5000);

      if (addBtn) {
        await addBtn.click();
        await shortDelay();
        clicked = true;
      } else {
        // DOM 좌표 스캔 fallback: data-placeholder 또는 텍스트로 탐색
        console.log('[Threads] 버튼 탐색 실패 → DOM 스캔으로 "스레드에 추가" 탐색...');
        const found = await page.evaluate(function() {
          const KEYWORDS = ['스레드에 추가', '이어서 작성', 'Add to thread'];
          const all = Array.from(document.querySelectorAll('*'));
          for (const el of all) {
            const placeholder = el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '';
            const directText = Array.from(el.childNodes)
              .filter(function(n) { return n.nodeType === 3; })
              .map(function(n) { return n.textContent ? n.textContent.trim() : ''; })
              .join('').trim();
            const isMatch = KEYWORDS.some(function(k) { return placeholder.includes(k) || directText.includes(k); });
            if (!isMatch) continue;
            const rect = (el as HTMLElement).getBoundingClientRect();
            const style = window.getComputedStyle(el as HTMLElement);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (rect.width > 0 && rect.height > 0) {
              return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
                isEditable: el.getAttribute('contenteditable') !== null,
              };
            }
          }
          return null;
        });

        if (!found) {
          console.log('[Threads] "스레드에 추가" 요소를 찾을 수 없음 → 댓글 건너뜀');
          return;
        }

        console.log(`[Threads] DOM 스캔 발견: (${Math.round(found.x)}, ${Math.round(found.y)}), editable=${found.isEditable}`);
        await page.mouse.click(found.x, found.y);
        await shortDelay();

        if (found.isEditable) {
          await humanTypeText(page, comment);
          console.log('[Threads] 댓글 입력 완료 (DOM 스캔 → editable 직접 입력)');
          return;
        }
        clicked = true;
      }

      if (!clicked) return;

      // 새 contenteditable 슬롯이 추가될 때까지 대기
      await page.waitForFunction((count: number) => {
        return document.querySelectorAll('[contenteditable="true"]').length > count;
      }, beforeCount, { timeout: 5000 }).catch(() => {});
      await sleep(randomInt(300, 500));

      const afterCount = await page.locator('[contenteditable="true"]').count();
      if (afterCount <= beforeCount) {
        // 슬롯이 늘어나지 않았으면 placeholder contenteditable에 재시도
        const fallback = await this.findFirst([
          () => page.locator('[contenteditable][data-placeholder*="스레드에 추가"]'),
          () => page.locator('[contenteditable][data-placeholder*="이어서"]'),
        ], 2000);
        if (fallback) {
          await fallback.click();
          await shortDelay();
          await humanTypeText(page, comment);
          console.log('[Threads] 댓글 입력 완료 (fallback 슬롯)');
        } else {
          console.log('[Threads] 댓글 슬롯 생성 실패 → 건너뜀');
        }
        return;
      }

      // 마지막(=새로 추가된) contenteditable에 입력
      const replyInput = page.locator('[contenteditable="true"]').nth(afterCount - 1);
      await replyInput.click();
      await shortDelay();
      await humanTypeText(page, comment);
      console.log(`[Threads] 댓글 입력 완료 (슬롯 ${afterCount - 1}번)`);
    } catch (e) {
      console.log('[Threads] 댓글 추가 실패 (건너뜀):', e instanceof Error ? e.message : e);
    }
  }

  /** ⋯ 더 보기 메뉴 열기 → "예약" 선택 */
  private async openScheduleMenu(page: Page): Promise<void> {
    await shortDelay();
    console.log('[Threads] ⋯ 메뉴 탐색 중...');

    const moreBtn = await this.findFirst([
      () => page.locator('[role="dialog"]').getByRole('button', { name: /더 보기|더보기/i }),
      () => page.locator('[role="dialog"] button[aria-label*="더 보기"]'),
      () => page.locator('[role="dialog"] button[aria-label*="More"]'),
      () => page.locator('[role="dialog"] [aria-label*="더 보기"]'),
      // 미디어 첨부 후 dialog 범위 밖에 버튼이 있을 경우 대비
      () => page.getByRole('button', { name: /더 보기|더보기/i }),
      () => page.locator('button[aria-label*="더 보기"]'),
    ], 8000);

    if (!moreBtn) throw new Error('⋯ 메뉴 버튼을 찾을 수 없습니다. (예약 기능 접근 불가)');
    await moreBtn.click();
    await shortDelay();

    console.log('[Threads] "예약" 메뉴 항목 탐색 중...');
    const scheduleOpt = await this.findFirst([
      () => page.getByRole('menuitem', { name: /예약/i }),
      () => page.getByRole('option', { name: /예약/i }),
      () => page.locator('[role="menuitem"]:has-text("예약")'),
      () => page.locator('[role="listitem"]:has-text("예약")'),
      () => page.locator('[role="menu"] button:has-text("예약")').first(),
      () => page.locator('[role="menu"] [role="button"]:has-text("예약")').first(),
      () => page.locator('button:has-text("예약")').first(),
      () => page.locator('[role="button"]:has-text("예약")').first(),
    ], 5000);

    if (!scheduleOpt) {
      // DOM 좌표 스캔 fallback
      console.log('[Threads] 셀렉터 실패 → DOM 좌표 스캔으로 "예약" 탐색...');
      const candidates = await page.evaluate(function() {
        var results: { x: number; y: number; text: string }[] = [];
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
            results.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: directText });
          }
        }
        return results;
      });
      if (candidates.length > 0) {
        const t = candidates[0];
        console.log(`[Threads] DOM 스캔 "예약" 발견: (${Math.round(t.x)}, ${Math.round(t.y)})`);
        await page.mouse.click(t.x, t.y);
        await mediumDelay();
        console.log('[Threads] 예약 다이얼로그 열림 (좌표 클릭)');
        return;
      }
      throw new Error('"예약" 메뉴를 찾을 수 없습니다. Threads 계정의 예약 기능이 활성화되어 있는지 확인하세요.');
    }
    await scheduleOpt.click();
    await mediumDelay();
    console.log('[Threads] 예약 다이얼로그 열림');
  }

  /** 예약 다이얼로그에서 날짜/시간 입력 */
  private async setScheduleDateTime(page: Page, targetTime: Date): Promise<void> {
    const year = targetTime.getFullYear();
    const month = targetTime.getMonth() + 1;
    const day = targetTime.getDate();
    const hours = targetTime.getHours();   // 0-23 local time
    const minutes = targetTime.getMinutes();
    const isPM = hours >= 12;
    const hour12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;

    console.log(`[Threads] 예약 시간 설정: ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')} ${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`);

    // ── 날짜 설정 ──────────────────────────────────────────────────────────
    const dateInput = await page.$('input[type="date"]');
    if (dateInput) {
      const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      await dateInput.fill(dateStr);
      await page.keyboard.press('Tab');
      await shortDelay();
      console.log(`[Threads] 날짜 input 설정: ${dateStr}`);
    } else {
      // 커스텀 날짜 피커: 오늘과 다른 경우에만 시도
      const today = new Date();
      if (day !== today.getDate() || month !== (today.getMonth() + 1) || year !== today.getFullYear()) {
        console.log('[Threads] 날짜 변경 필요 — 커스텀 피커 탐색 중...');
        const dateBtn = await this.findFirst([
          () => page.locator('button[aria-label*="날짜"]').first(),
          () => page.locator('[class*="date-picker"] button, [class*="DatePicker"] button').first(),
        ], 2000);
        if (dateBtn) {
          await dateBtn.click();
          await shortDelay();
          const dayBtn = await this.findFirst([
            () => page.getByRole('button', { name: new RegExp(`^${day}$`) }),
          ], 3000);
          if (dayBtn) { await dayBtn.click(); await shortDelay(); }
        }
      }
    }

    // ── 시간 설정 ──────────────────────────────────────────────────────────
    const timeInput = await page.$('input[type="time"]');
    if (timeInput) {
      const timeStr = `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}`;
      await timeInput.fill(timeStr);
      await page.keyboard.press('Tab');
      await shortDelay();
      console.log(`[Threads] 시간 input 설정: ${timeStr}`);
    } else {
      await this.setCustomTimePicker(page, hours, minutes, isPM, hour12);
    }
  }

  /** 커스텀 시간 피커 (select / spinbutton / number input 지원) */
  private async setCustomTimePicker(
    page: Page, hours: number, minutes: number, isPM: boolean, hour12: number
  ): Promise<void> {
    console.log(`[Threads] 커스텀 시간 피커: ${isPM ? '오후' : '오전'} ${hour12}시 ${minutes}분`);

    // AM/PM 선택
    const ampmSel = await page.$('select[aria-label*="오전"], select[aria-label*="오후"], select[aria-label*="AM"]');
    if (ampmSel) {
      await ampmSel.selectOption(isPM ? { label: '오후' } : { label: '오전' });
      await shortDelay();
    } else {
      const ampmBtn = await this.findFirst([
        () => page.locator(`button:has-text("${isPM ? '오후' : '오전'}")`),
        () => page.getByRole('button', { name: isPM ? /오후|PM/i : /오전|AM/i }),
      ], 2000);
      if (ampmBtn) { await ampmBtn.click(); await shortDelay(); }
    }

    // 시 (hour) 선택
    const hourSel = await page.$('select[aria-label*="시"], select[aria-label*="hour"]');
    if (hourSel) {
      // Try 12-hour value first, then 24-hour
      try { await hourSel.selectOption(String(hour12)); }
      catch { try { await hourSel.selectOption(String(hours)); } catch { /* ignore */ } }
      await shortDelay();
      console.log('[Threads] 시 select 완료');
    }

    // 분 (minute) 선택 — 가장 가까운 옵션 선택
    const minuteSel = await page.$('select[aria-label*="분"], select[aria-label*="minute"]');
    if (minuteSel) {
      const opts = await minuteSel.$$('option');
      let bestVal = String(minutes);
      let bestDiff = Infinity;
      for (const opt of opts) {
        const v = await opt.getAttribute('value');
        if (v !== null) {
          const d = Math.abs(parseInt(v, 10) - minutes);
          if (d < bestDiff) { bestDiff = d; bestVal = v; }
        }
      }
      await minuteSel.selectOption(bestVal);
      await shortDelay();
      console.log('[Threads] 분 select 완료');
    }

    // 폴백: number input / spinbutton
    if (!hourSel && !minuteSel) {
      const numInputs = await page.$$('input[type="number"], input[inputmode="numeric"], [role="spinbutton"]');
      console.log(`[Threads] 숫자 입력 필드 ${numInputs.length}개 발견`);
      if (numInputs.length >= 1) {
        await numInputs[0].click();
        await page.keyboard.press('Control+a');
        await page.keyboard.type(String(hour12).padStart(2, '0'));
        await shortDelay();
      }
      if (numInputs.length >= 2) {
        await numInputs[1].click();
        await page.keyboard.press('Control+a');
        await page.keyboard.type(String(minutes).padStart(2, '0'));
        await shortDelay();
      }
    }
  }

  /** 날짜/시간 확정: "완료" 클릭 → 최종 "예약" 버튼 클릭 */
  private async confirmSchedule(page: Page): Promise<void> {
    const doneBtn = await this.findFirst([
      () => page.getByRole('button', { name: /^완료$|^Done$/i }),
      () => page.locator('button:has-text("완료"), button:has-text("Done")').last(),
    ], 8000);
    if (doneBtn) {
      await doneBtn.click();
      await mediumDelay();
      console.log('[Threads] "완료" 클릭');
    }

    // 최종 "예약" 버튼 (게시 대신)
    const scheduleBtn = await this.findFirst([
      () => page.locator('[role="dialog"]').getByRole('button', { name: /^예약$/ }),
      () => page.getByRole('button', { name: /^예약$/ }),
      () => page.locator('[role="dialog"] button:has-text("예약")').last(),
    ], 8000);

    if (!scheduleBtn) throw new Error('"예약" 최종 버튼을 찾을 수 없습니다. (날짜/시간 설정이 완료되었는지 확인하세요)');
    await scheduleBtn.click();
    console.log('[Threads] 최종 "예약" 버튼 클릭');

    // 모달이 닫히면 예약 완료
    await page.waitForFunction(function() {
      return !document.querySelector('[data-lexical-editor][contenteditable="true"]');
    }, { timeout: 20000 }).catch(() => {
      console.log('[Threads] 모달 닫힘 확인 타임아웃 (계속 진행)');
    });
    await mediumDelay();
  }

  // ─── 단일 페이지 기반 예약 (배치 스케줄러용: 브라우저 열기/닫기 없음) ──────────
  /**
   * 이미 열려 있는 페이지에서 예약합니다.
   * 배치 스케줄러가 하나의 컨텍스트를 여러 포스트에 재사용할 때 호출합니다.
   */
  async scheduleOnPage(
    page: Page,
    mainContent: string,
    commentContent: string,
    scheduledTime: Date,
  ): Promise<PostResult> {
    try {
      const now = new Date();
      const minMs = 15 * 60 * 1000;
      const targetTime = scheduledTime.getTime() - now.getTime() < minMs
        ? new Date(now.getTime() + minMs)
        : scheduledTime;

      const { mainText, hashtags } = this.splitContentAndHashtags(mainContent);

      // 홈으로 이동 (이전 포스트 예약 완료 후 다른 URL에 있을 수 있음)
      if (!page.url().startsWith(THREADS_URL)) {
        await page.goto(THREADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await sleep(randomInt(1000, 2000));
      }

      const createBtn = await this.findFirst([
        () => page.getByRole('link', { name: /만들기/i }),
        () => page.getByRole('button', { name: /만들기/i }),
        () => page.locator('[aria-label*="만들기"], [aria-label*="New thread"], [aria-label*="Create"]'),
        () => page.locator('a[href*="compose"], a[href*="create"]'),
      ], 5000);
      if (!createBtn) throw new Error('[만들기] 버튼을 찾을 수 없습니다.');
      await createBtn.click();
      await mediumDelay();

      const textInput = await this.findFirst([
        () => page.locator('[contenteditable="true"][data-lexical-editor]').first(),
        () => page.locator('[role="dialog"] [contenteditable="true"]').first(),
        () => page.getByRole('textbox').first(),
        () => page.locator('[contenteditable="true"]').first(),
      ], 10000);
      if (!textInput) throw new Error('텍스트 입력창을 찾을 수 없습니다.');
      await textInput.click();
      await shortDelay();
      await humanTypeText(page, mainText);

      if (hashtags.length > 0) await this.addTopics(page, hashtags);
      if (commentContent && commentContent.trim()) {
        await this.addThreadReplyInCompose(page, commentContent);
      }

      await this.openScheduleMenu(page);
      await this.setScheduleDateTime(page, targetTime);
      await this.confirmSchedule(page);

      console.log(`[Threads] 페이지 예약 완료 ✅ ${targetTime.toLocaleString('ko-KR')}`);
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[Threads] 페이지 예약 오류:', msg);
      return { success: false, error: msg };
    }
  }

  // ─── 로그인 세션 설정 ─────────────────────────────────────────────────────
  async openForLogin(profileDir: string, expectedUsername?: string): Promise<void> {
    console.log('[Threads] 로그인 브라우저 열기...');
    const context = await this.openContext(profileDir);
    const page = await context.newPage();

    await page.goto(THREADS_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    const isLoggedIn = !currentUrl.includes('/login') && !currentUrl.includes('accounts/login');

    if (isLoggedIn && expectedUsername) {
      const loggedInUsername = await this.getCurrentUsername(page);
      if (loggedInUsername && loggedInUsername !== expectedUsername.toLowerCase()) {
        console.log(`[Threads] 현재 로그인: @${loggedInUsername}, 필요: @${expectedUsername} → 로그아웃 진행`);
        await this.logoutThreads(page);
        console.log('[Threads] 로그아웃 완료. @' + expectedUsername + ' 계정으로 로그인하세요.');
      } else if (loggedInUsername === expectedUsername.toLowerCase()) {
        console.log(`[Threads] 이미 @${loggedInUsername} 계정으로 로그인되어 있습니다.`);
      }
    }

    console.log('[Threads] 브라우저에서 로그인 후 창을 닫으세요.');
    await page.waitForEvent('close', { timeout: 300000 }).catch(() => {});
    await context.close().catch(() => {});
    console.log('[Threads] 로그인 세션이 저장되었습니다.');
  }
}

export const threadsPoster = new ThreadsPoster();
