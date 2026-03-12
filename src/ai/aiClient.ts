import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { sleep, randomInt } from '../human/humanBehavior';

// AI 타입별 셀렉터 기본값
const AI_PRESETS: Record<string, { inputSelector: string; submitSelector: string; outputSelector: string }> = {
  claude: {
    inputSelector: '[contenteditable="true"][data-placeholder]',
    submitSelector: 'button[aria-label="Send message"]',
    outputSelector: '',  // waitForStableContent 내부 로직 사용
  },
  gemini: {
    inputSelector: '.ql-editor[contenteditable="true"], rich-textarea .ql-editor',
    submitSelector: 'button[aria-label="Send message"], button.send-button, [data-mat-icon-name="send"]',
    outputSelector: 'model-response',
  },
  genspark: {
    inputSelector: 'textarea[placeholder], textarea.chat-input, [contenteditable="true"]',
    submitSelector: 'button[type="submit"], button.send-btn, button[aria-label*="send"], button[aria-label*="Send"]',
    outputSelector: '.agent-turn, .response-block, .answer-content',
  },
  custom: {
    inputSelector: '',
    submitSelector: '',
    outputSelector: '',
  },
};

export interface AIConfig {
  id: number;
  ai_type: string;
  url: string;
  profile_dir: string;
  input_selector?: string;
  submit_selector?: string;
  output_selector?: string;
}

export class AIClient {
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

  private getSelectors(config: AIConfig) {
    const preset = AI_PRESETS[config.ai_type] || AI_PRESETS.custom;
    return {
      input: config.input_selector || preset.inputSelector,
      submit: config.submit_selector || preset.submitSelector,
      output: config.output_selector || preset.outputSelector,
    };
  }

  private removeSingletonLock(userDataDir: string): void {
    for (const lock of ['SingletonLock', 'SingletonSocket', 'lockfile']) {
      try { fs.rmSync(path.join(userDataDir, lock), { force: true, recursive: true }); } catch { /* ignore */ }
    }
  }

  async openContext(profileDir: string): Promise<BrowserContext> {
    const userDataDir = this.getProfileDir(profileDir);
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

  // ─── 텍스트 입력 (클립보드 붙여넣기 → insertText 폴백) ────────────────────
  private async pasteTextIntoInput(page: Page, inputEl: import('playwright').ElementHandle, text: string): Promise<void> {
    // 1. 클릭 + 포커스 확보
    await inputEl.click();
    await sleep(300);

    // 2. 기존 내용 전체 선택 후 삭제 (append 방지)
    await page.keyboard.press('Control+a');
    await sleep(100);
    await page.keyboard.press('Delete');
    await sleep(200);

    // 3. 클립보드 API로 붙여넣기 (React/Lexical 에디터에서 가장 신뢰도 높음)
    try {
      // 클립보드 권한 부여 후 직접 붙여넣기
      await page.evaluate(function(t) {
        // DataTransfer를 이용한 paste 이벤트 dispatch (clipboard API 없이 동작)
        var el = document.activeElement;
        if (!el) return false;
        var dt = new DataTransfer();
        dt.setData('text/plain', t);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      }, text);

      await sleep(500);

      // 붙여넣기 성공 여부 확인 (입력창에 내용이 있으면 성공)
      const hasContent = await page.evaluate(function() {
        var el = document.activeElement;
        if (!el) return false;
        return (el.textContent || '').trim().length > 0;
      });

      if (hasContent) {
        console.log('[AI] 클립보드 붙여넣기 성공');
        return;
      }
    } catch (e) {
      console.log('[AI] 클립보드 붙여넣기 실패, insertText 폴백 시도');
    }

    // 4. 폴백: Playwright insertText (대부분의 입력창에서 동작)
    await inputEl.click();
    await sleep(200);
    await page.keyboard.insertText(text);
    await sleep(300);
    console.log('[AI] insertText 완료');
  }

  // ─── AI 콘텐츠 생성 ───────────────────────────────────────────────────────
  async generateContent(config: AIConfig, prompt: string): Promise<string> {
    const context = await this.openContext(config.profile_dir);
    let page: Page | null = null;

    try {
      page = await context.newPage();
      const selectors = this.getSelectors(config);

      // ── 1. 페이지 열기 ──────────────────────────────────────────────────
      console.log(`[AI] ${config.ai_type} 열기: ${config.url}`);
      await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await sleep(1000);

      // ── 2. 입력창 찾기 ──────────────────────────────────────────────────
      console.log(`[AI] 입력창 찾는 중... (셀렉터: ${selectors.input || '자동'} )`);
      let inputEl = await page.waitForSelector(selectors.input, { timeout: 15000 }).catch(() => null);

      // 입력창을 못 찾으면 일반 textarea / contenteditable 폴백
      if (!inputEl) {
        console.log('[AI] 기본 셀렉터 실패, 폴백 셀렉터 시도...');
        inputEl = await page.waitForSelector(
          'textarea:not([disabled]), [contenteditable="true"]:not([aria-readonly="true"])',
          { timeout: 10000 }
        ).catch(() => null);
      }

      if (!inputEl) {
        throw new Error(
          `입력창을 찾을 수 없습니다.\n` +
          `• 셀렉터: "${selectors.input}"\n` +
          `• AI 설정에서 로그인이 되어 있는지 확인하세요.\n` +
          `• AI 타입(${config.ai_type})이 올바른지 확인하세요.`
        );
      }

      // ── 3. 프롬프트 입력 ────────────────────────────────────────────────
      console.log(`[AI] 프롬프트 입력 중... (${prompt.length}자)`);
      await this.pasteTextIntoInput(page, inputEl, prompt);

      // ── 4. 전송 ─────────────────────────────────────────────────────────
      console.log('[AI] 메시지 전송 중...');
      let submitted = false;

      if (selectors.submit) {
        const submitEl = await page.$(selectors.submit);
        if (submitEl) {
          const disabled = await submitEl.getAttribute('disabled');
          const ariaDisabled = await submitEl.getAttribute('aria-disabled');
          if (!disabled && ariaDisabled !== 'true') {
            await submitEl.click();
            submitted = true;
            console.log('[AI] 전송 버튼 클릭 성공');
          } else {
            console.log('[AI] 전송 버튼이 비활성화 상태 — Enter 키 사용');
          }
        }
      }

      if (!submitted) {
        // 입력창에 포커스 후 Enter
        await inputEl.click().catch(() => {});
        await sleep(100);
        await page.keyboard.press('Enter');
        console.log('[AI] Enter 키로 전송');
      }

      await sleep(1000);

      // ── 5. 응답 대기 ────────────────────────────────────────────────────
      console.log('[AI] 응답 대기 중 (최대 3분)...');
      const content = await this.waitForResponse(page, config.ai_type, selectors.output);
      const trimmed = content.trim();

      if (!trimmed) {
        throw new Error(
          `AI 응답이 비어 있습니다.\n` +
          `• AI(${config.ai_type})가 로그인되어 있는지 확인하세요.\n` +
          `• 출력 셀렉터가 맞는지 확인하세요: "${selectors.output || '자동'}"`
        );
      }

      console.log(`[AI] 응답 완료 (${trimmed.length}자)`);
      return trimmed;

    } finally {
      if (page) await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  // ─── 응답 완료 대기 ───────────────────────────────────────────────────────
  private async waitForResponse(page: Page, aiType: string, outputSelector: string): Promise<string> {
    const maxWait = 180000; // 3분

    // Claude: 전송 버튼 재활성화 = 응답 완료 신호
    if (aiType === 'claude') {
      await page.waitForFunction(
        function() {
          var btn = document.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
          return btn && !btn.disabled;
        },
        { timeout: maxWait }
      ).catch(() => {});
      await sleep(500); // 마지막 토큰 렌더링 대기
    }

    // Gemini: 로딩 인디케이터 사라질 때까지
    if (aiType === 'gemini') {
      await page.waitForSelector(
        '.loading-indicator, [aria-label*="thinking"], [aria-label*="Gemini is thinking"], mat-progress-bar',
        { state: 'hidden', timeout: maxWait }
      ).catch(() => {});
      await sleep(500);
    }

    // Genspark 등 범용: 로딩 클래스 사라질 때까지
    if (aiType === 'genspark' || aiType === 'custom') {
      await page.waitForSelector(
        '[class*="loading"], [class*="spinner"], [class*="typing"]',
        { state: 'hidden', timeout: 60000 }
      ).catch(() => {});
      await sleep(500);
    }

    return this.waitForStableContent(page, outputSelector, aiType, maxWait);
  }

  // ─── 콘텐츠 안정화 대기 ──────────────────────────────────────────────────
  // 500ms마다 텍스트를 읽어 4회(2초) 연속 동일하면 완료로 판단.
  // <details>(사고 섹션)는 cloneNode 후 제거해서 thinking 텍스트가 섞이지 않게 처리.
  private async waitForStableContent(
    page: Page,
    outputSelector: string,
    aiType: string,
    maxWait: number,
  ): Promise<string> {
    const startTime = Date.now();
    let lastContent = '';
    let sameCount = 0;

    const normalize = (s: string) =>
      s.replace(/█+/g, '').replace(/▌/g, '').trim();

    while (Date.now() - startTime < maxWait) {
      const raw = await page.evaluate(function(args) {
        var sel = args.sel;
        var type = args.type;

        function extractText(el: any) {
          var clone = el.cloneNode(true);
          // 사고(thinking) 섹션 제거
          clone.querySelectorAll('details').forEach(function(d: any) { d.remove(); });
          clone.querySelectorAll(
            '[class*="thinking"], [class*="reasoning"], [class*="thought"], [class*="chain-of"]'
          ).forEach(function(d: any) { d.remove(); });
          return clone.innerText ? clone.innerText.trim() : '';
        }

        function isThinkingEl(el: any) {
          if (el.closest && el.closest('details')) return true;
          var cls = (el.getAttribute('class') || '').toLowerCase();
          return ['thinking', 'reasoning', 'thought', 'chain-of'].some(function(k) {
            return cls.includes(k);
          });
        }

        // 1. Claude: 마지막 대화 턴에서 추출
        if (type === 'claude') {
          var turns = document.querySelectorAll('[data-testid="conversation-turn"]');
          if (turns.length > 0) return extractText(turns[turns.length - 1]);
        }

        // 2. Gemini: model-response 마지막
        if (type === 'gemini') {
          var responses = document.querySelectorAll('model-response');
          if (responses.length > 0) {
            var last = responses[responses.length - 1];
            return extractText(last.querySelector('.response-content, .markdown') || last);
          }
        }

        // 3. 사용자 지정 output_selector
        if (sel) {
          var els = document.querySelectorAll(sel);
          if (els.length > 0) {
            var text = extractText(els[els.length - 1]);
            if (text.length > 20) return text;
          }
        }

        // 4. 범용 폴백: message/response/assistant 클래스 역순
        var candidates = document.querySelectorAll(
          '[class*="message"], [class*="response"], [class*="answer"], [class*="assistant"], [class*="agent"]'
        );
        var arr = Array.from(candidates).reverse();
        for (var i = 0; i < arr.length; i++) {
          var c = arr[i] as any;
          if (isThinkingEl(c)) continue;
          var ct = extractText(c);
          if (ct.length > 20 && ct.length < 20000) return ct;
        }

        // 5. 최후 폴백: prose/markdown 단락
        var paras = document.querySelectorAll('.prose p, .markdown p, .markdown-body p, article p, main p');
        var parasArr = Array.from(paras).reverse();
        for (var j = 0; j < parasArr.length; j++) {
          var pt = (parasArr[j] as any).innerText;
          if (pt && pt.trim().length > 20) return pt.trim();
        }
        return '';
      }, { sel: outputSelector, type: aiType });

      const normalized = normalize(raw);

      if (normalized.length > 20 && normalized === normalize(lastContent)) {
        if (sameCount === 0) {
          console.log(`[AI] 응답 감지, 안정화 확인 중: "${normalized.slice(0, 60)}..."`);
        }
        sameCount++;
        if (sameCount >= 4) {
          console.log(`[AI] 응답 안정화 완료 (${normalized.length}자)`);
          return normalized;
        }
      } else {
        if (normalized.length > 0 && normalized !== normalize(lastContent)) {
          console.log(`[AI] 콘텐츠 변화 감지 (${normalized.length}자)`);
        }
        sameCount = 0;
      }
      lastContent = raw;
      await sleep(500);
    }

    return normalize(lastContent);
  }

  // 로그인용 브라우저 열기
  async openForLogin(config: AIConfig): Promise<void> {
    console.log(`[AI] 로그인 브라우저 열기: ${config.url}`);
    const context = await this.openContext(config.profile_dir);
    const page = await context.newPage();
    await page.goto(config.url);
    console.log('[AI] 브라우저에서 로그인 후 창을 닫으면 세션이 저장됩니다.');
    await page.waitForEvent('close', { timeout: 300000 }).catch(() => {});
    await context.close().catch(() => {});
    console.log('[AI] 세션이 저장되었습니다.');
  }
}

export const aiClient = new AIClient();
