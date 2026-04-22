import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import { sleep, randomInt } from '../human/humanBehavior';
import { PostCard, ScrapedPost } from './types';

// ── 공통 상수 ─────────────────────────────────────────────────────────────────
const INTERNAL_URL = /threads\.net\/@|threads\.net\/t\/|threads\.net\/search|threads\.com\/@|threads\.com\/t\//;
const MIN_TEXT_LEN = 10; // 유효 본문 최소 길이

// ── 텍스트에서 외부 링크 분리 ────────────────────────────────────────────────
export function separateTextAndLinks(raw: string): { text: string; links: string[] } {
  const links: string[] = [];
  const urlMatches = raw.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  for (const m of urlMatches) {
    const clean = m.replace(/[.)，,]+$/, '');
    if (!INTERNAL_URL.test(clean) && !links.includes(clean)) links.push(clean);
  }
  // 텍스트에서 URL 제거 후 공백 정리
  const text = raw
    .replace(/https?:\/\/[^\s"'<>]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, links };
}

// ── 계정명(@mention)만 있는지 판별 ───────────────────────────────────────────
export function isOnlyMentions(text: string): boolean {
  return /^(@[\w.]+\s*)+$/.test(text.trim());
}

// ── Threads 내부 API JSON 파서 ────────────────────────────────────────────────
type ApiParsed = Pick<ScrapedPost, 'textContent' | 'mediaUrls' | 'commentText' | 'commentLinks'>;

/**
 * JSON 트리에서 thread 객체를 추출.
 *
 * 우선순위:
 *   ① root.containing_thread                          — 원본 스레드 전체 (thread_items[0]=원본, [1]=연결글)
 *   ② specificKey.containing_thread (중첩된 경우)      — 체인 포스트 URL 방문 시에도 원본 포스트 확보
 *   ③ specificKey 직접                                 — containing_thread 없을 때 폴백
 *   ④ edges/node 폴백
 *
 * ⚠ containing_thread를 우선해야 원문 본문/첫 댓글 역전 방지됨.
 *   체인 포스트 URL 방문 시 containing_thread 없이 barcelona_thread_by_post_id만 오면
 *   thread_items[0]이 연결글(쿠팡 파트너스 공시문 등)이 되어 원문 본문이 역전됨.
 */
function extractThreadNode(json: any): { thread: any; replyThreads: any[] } | null {
  try {
    const candidates: any[] = [json, json?.data, json?.data?.data];

    const specificKeys = [
      'barcelona_thread_by_post_id',
      'thread_by_post_id',
      'xdt_api__v1__text_feed__thread_post_id_to_media_v2',
      'xdt_api__v1__text_feed__post_to_user',
    ] as const;

    for (const root of candidates) {
      if (!root) continue;

      // ① root.containing_thread — 최우선
      if (root.containing_thread) {
        const thread = root.containing_thread;
        const replyThreads: any[] = root.reply_threads ?? thread.reply_threads ?? [];
        return { thread, replyThreads };
      }

      // ② 특정 포스트 키 내부에 containing_thread가 있으면 그것을 우선 사용
      //    (체인 포스트 URL 방문 시 API가 specificKey 안에 containing_thread를 포함하는 경우)
      for (const key of specificKeys) {
        const node = root[key];
        if (!node) continue;
        if (node.containing_thread) {
          const thread = node.containing_thread;
          const replyThreads: any[] = node.reply_threads ?? root.reply_threads ?? thread.reply_threads ?? [];
          return { thread, replyThreads };
        }
      }

      // ③ containing_thread 없음 — specificKey 직접 사용 (thread_items[0]이 연결글일 수 있음)
      for (const key of specificKeys) {
        const node = root[key];
        if (!node) continue;
        const replyThreads: any[] = node.reply_threads ?? root.reply_threads ?? [];
        return { thread: node, replyThreads };
      }

      // ④ edges/node 폴백
      const thread = root.edges?.[0]?.node ?? root.node ?? null;
      if (thread) {
        const replyThreads: any[] =
          root.reply_threads ??
          thread.reply_threads ??
          root.edges?.slice(1).map((e: any) => e?.node).filter(Boolean) ??
          [];
        return { thread, replyThreads };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function parseThreadsApiJson(json: any): ApiParsed | null {
  try {
    const extracted = extractThreadNode(json);
    if (!extracted) return null;

    const { thread, replyThreads } = extracted;
    const threadItems: any[] = thread.thread_items ?? thread.nodes?.[0]?.thread_items ?? [];
    const mainPost = threadItems[0]?.post;
    if (!mainPost) return null;

    // ── 본문 텍스트 ─────────────────────────────────────────────────────────
    const textContent: string = mainPost.caption?.text ?? mainPost.text ?? '';

    // ── 미디어 (이미지 + 동영상 + 캐러셀) ────────────────────────────────────
    const mediaUrls: string[] = [];

    function addImgCandidates(candidates: any[]) {
      if (!candidates?.length) return;
      const best = [...candidates].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
      if (best?.url && !mediaUrls.includes(best.url)) mediaUrls.push(best.url);
    }

    function addMediaFromPost(post: any) {
      addImgCandidates(post.image_versions2?.candidates ?? []);
      const vidVersions: any[] = post.video_versions ?? [];
      if (vidVersions[0]?.url && !mediaUrls.includes(vidVersions[0].url)) mediaUrls.push(vidVersions[0].url);
      for (const item of (post.carousel_media ?? [])) {
        addImgCandidates(item.image_versions2?.candidates ?? []);
        const vvs: any[] = item.video_versions ?? [];
        if (vvs[0]?.url && !mediaUrls.includes(vvs[0].url)) mediaUrls.push(vvs[0].url);
      }
    }

    addMediaFromPost(mainPost);

    // ── 첫 번째 댓글 추출 ────────────────────────────────────────────────────
    let commentText: string | undefined;
    let commentLinks: string[] = [];

    function trySetComment(raw: string): boolean {
      if (!raw || raw.trim().length < 5) return false;
      if (isOnlyMentions(raw)) return false;
      if (raw.trim() === textContent.trim()) return false;
      const separated = separateTextAndLinks(raw);
      if (!separated.text && separated.links.length === 0) return false;
      commentText = separated.text || undefined;
      commentLinks = separated.links;
      return true;
    }

    // 1) 작성자 체인 포스트 (thread_items[1]) — 가장 신뢰도 높음
    const chainPost = threadItems[1]?.post;
    if (chainPost) {
      const chainRaw: string = chainPost.caption?.text ?? chainPost.text ?? '';
      trySetComment(chainRaw);
    }

    // 2) reply_threads — 최대 5개, 각 index 0·1 시도
    if (!commentText && commentLinks.length === 0) {
      outer: for (const rt of replyThreads.slice(0, 5)) {
        const items: any[] = rt.thread_items ?? rt.node?.thread_items ?? [];
        for (const idx of [0, 1]) {
          const rp = items[idx]?.post;
          if (!rp) continue;
          const raw: string = rp.caption?.text ?? rp.text ?? '';
          if (trySetComment(raw)) break outer;
        }
      }
    }

    // 3) thread_items 나머지 항목 (idx 2 이상)
    if (!commentText && commentLinks.length === 0) {
      for (let i = 2; i < threadItems.length; i++) {
        const rp = threadItems[i]?.post;
        if (!rp) continue;
        const raw: string = rp.caption?.text ?? rp.text ?? '';
        if (trySetComment(raw)) break;
      }
    }

    if (!textContent && mediaUrls.length === 0) return null;
    return { textContent, mediaUrls, commentText, commentLinks };
  } catch {
    return null;
  }
}

// ── 스크래퍼 클래스 ──────────────────────────────────────────────────────────
export class ThreadsScraper {
  private readonly profilesBase = path.join(process.cwd(), 'data', 'browser-profiles');

  private removeSingletonLock(dir: string): void {
    for (const f of ['SingletonLock', 'SingletonSocket', 'lockfile']) {
      try { fs.rmSync(path.join(dir, f), { force: true, recursive: true }); } catch { /* ignore */ }
    }
  }

  openContext(profileDir: string): Promise<BrowserContext> {
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

  /**
   * 프로필 페이지에서 게시글 목록 + 조회수를 수집 후 조회수 내림차순 정렬 반환.
   */
  async getPostCards(
    profileUrl: string,
    scraperProfileDir: string,
    existingCtx?: BrowserContext,
  ): Promise<PostCard[]> {
    const owned = !existingCtx;
    const context = existingCtx ?? await this.openContext(scraperProfileDir);
    let page: Page | null = null;
    try {
      page = await context.newPage();
      console.log(`[Scraper] 프로필 이동 (게시글 목록): ${profileUrl}`);
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
      await sleep(randomInt(2000, 3500));

      // 스크롤로 더 많은 게시글 로드
      for (let i = 0; i < 3; i++) {
        await page.evaluate(function() { window.scrollBy(0, 400); });
        await sleep(randomInt(700, 1200));
      }

      // NOTE: no named arrow functions inside evaluate — avoids __name injection by esbuild
      const cards = await page.evaluate(function() {
        var results = [];
        var seen = new Set();
        var allLinks = Array.from(document.querySelectorAll('a[href*="/post/"]')) as any[];

        for (var i = 0; i < allLinks.length; i++) {
          var link = allLinks[i];
          var href = link.href;
          if (!href || seen.has(href)) continue;
          if (!/\/@[^/]+\/post\/[A-Za-z0-9_-]+$/.test(href)) continue;
          seen.add(href);

          var viewCount = 0;
          var container = link.parentElement;
          for (var j = 0; j < 8 && container; j++) {
            var tag = container.tagName ? container.tagName.toLowerCase() : '';
            if (tag === 'article' || container.getAttribute('role') === 'article') break;
            container = container.parentElement;
          }
          if (container) {
            var text = container.textContent || '';
            var patterns = [
              /(\d[\d,.]*)\s*조회/,
              /조회수\s*(\d[\d,.]*)/,
              /(\d[\d,.]*)\s*회\s*재생/,
              /(\d[\d,.]*)\s*views?/i,
            ];
            for (var k = 0; k < patterns.length; k++) {
              var m = text.match(patterns[k]);
              if (m) { viewCount = parseInt(m[1].replace(/[,.]/g, ''), 10); break; }
            }
          }
          results.push({ url: href, viewCount: viewCount });
        }
        return results;
      });

      if (cards.length === 0) {
        console.log('[Scraper] 프로필에서 게시글 링크를 찾을 수 없습니다. 로그인 여부를 확인하세요.');
        return [];
      }

      console.log(`[Scraper] 게시글 ${cards.length}개 발견 (조회수 추출: ${cards.filter((c: any) => c.viewCount > 0).length}개)`);
      (cards as PostCard[]).sort((a: any, b: any) => b.viewCount - a.viewCount);
      return cards as PostCard[];
    } finally {
      if (page) await page.close().catch(() => {});
      if (owned) await context.close().catch(() => {});
    }
  }

  /**
   * 게시글 페이지를 열고 본문·미디어·첫댓글(텍스트·링크 분리)을 스크랩.
   *
   * 전략 (우선순위):
   *   1. GraphQL API 인터셉션 (가장 안정적, 구조화 데이터)
   *   2. DOM 파싱 폴백 (API 실패 시)
   *
   * 검증 단계: 추출된 본문이 MIN_TEXT_LEN 미만이면 DOM 폴백 재시도.
   */
  async scrapePost(
    postUrl: string,
    scraperProfileDir: string,
    existingCtx?: BrowserContext,
  ): Promise<ScrapedPost | null> {
    const owned = !existingCtx;
    const context = existingCtx ?? await this.openContext(scraperProfileDir);
    let page: Page | null = null;
    try {
      page = await context.newPage();

      // ── API 응답 인터셉션 ─────────────────────────────────────────────────
      const captured: { data: ApiParsed | null } = { data: null };

      const onResponse = async (response: any) => {
        try {
          const url: string = response.url();
          // Threads / Instagram CDN 모두 커버
          const isRelevant =
            url.includes('threads.net') ||
            url.includes('threads.com') ||
            url.includes('i.instagram.com') ||
            url.includes('graph.instagram.com') ||
            url.includes('www.instagram.com');
          if (!isRelevant) return;

          // JSON 응답만 처리 (gql, graphql, api 경로 우선)
          const ct: string = (response.headers()['content-type'] ?? '');
          if (!ct.includes('json')) return;

          // 빠른 상태 코드 필터 (에러 응답 제외)
          if (response.status() >= 400) return;

          const json = await response.json().catch(() => null);
          if (!json) return;
          const parsed = parseThreadsApiJson(json);
          if (!parsed) return;

          const cur = captured.data;
          if (!cur) {
            // 최초 유효 응답 저장
            captured.data = parsed;
          } else {
            // 본문이 더 길면 교체 (단, 현재 본문이 MIN_TEXT_LEN 이상이면 교체 금지 → 추천글 덮어쓰기 방지)
            const curTextOk = cur.textContent.length >= MIN_TEXT_LEN;
            const newTextLonger = parsed.textContent.length > cur.textContent.length;
            if (!curTextOk && newTextLonger) {
              captured.data = parsed;
            } else if (curTextOk && (!cur.commentText && !cur.commentLinks.length) && (parsed.commentText || parsed.commentLinks.length)) {
              // 본문은 유지하고 댓글만 보강
              captured.data = { ...cur, commentText: parsed.commentText, commentLinks: parsed.commentLinks };
            }
          }
        } catch { /* silent */ }
      };
      page.on('response', onResponse);

      console.log(`[Scraper] 게시글 페이지 이동: ${postUrl}`);
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // networkidle 대기 (API 첫 응답 수집)
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForSelector('article, [dir="auto"], [data-pressable-container]', { timeout: 10000 }).catch(() => {});
      await sleep(randomInt(800, 1200));

      // 최대 5회 스크롤: 본문 + 댓글 모두 확보될 때까지
      for (let attempt = 0; attempt < 5; attempt++) {
        const hasText = captured.data && captured.data.textContent.length >= MIN_TEXT_LEN;
        const hasComment = captured.data && (captured.data.commentText || captured.data.commentLinks.length > 0);
        // 본문과 댓글 모두 있으면 조기 종료
        if (hasText && hasComment) break;
        await page.evaluate(function() { window.scrollBy(0, 300); });
        await sleep(randomInt(900, 1500));
        // 각 스크롤 후 networkidle 짧게 대기 (지연 로드 API 응답 수집)
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      }
      await sleep(randomInt(600, 1000));

      page.off('response', onResponse);

      // ── API 성공 + 검증 ──────────────────────────────────────────────────
      if (captured.data && captured.data.textContent.length >= MIN_TEXT_LEN) {
        const d = captured.data;
        console.log(
          `[Scraper] ✅ API — 본문: ${d.textContent.length}자, ` +
          `미디어: ${d.mediaUrls.length}개, ` +
          `댓글: ${d.commentText ? d.commentText.length + '자' : '없음'}, ` +
          `링크: ${d.commentLinks.length}개`
        );
        return {
          postUrl,
          textContent: d.textContent,
          mediaUrls: d.mediaUrls,
          commentText: d.commentText,
          commentLinks: d.commentLinks,
          scrapeMethod: 'api',
        };
      }

      if (captured.data) {
        console.log(`[Scraper] API 본문 너무 짧음 (${captured.data.textContent.length}자) → DOM 폴백`);
      } else {
        console.log('[Scraper] API 인터셉션 없음 → DOM 파싱');
      }

      // ── DOM 폴백 ─────────────────────────────────────────────────────────
      await page.evaluate(function() { window.scrollBy(0, 200); });
      await sleep(randomInt(600, 1000));

      // NOTE: all inner functions use `function` declaration (not named arrow expressions)
      // to avoid esbuild __name injection which breaks page.evaluate()
      const result = await page.evaluate(function(args: { url: string; internalPattern: string; minLen: number }) {
        var INTERNAL_RE = new RegExp(args.internalPattern);

        // nav/header/aside 등 UI 크롬 요소 내부인지 판별
        function isInUiChrome(el: any): boolean {
          var p = el;
          while (p) {
            var tag = (p.tagName || '').toLowerCase();
            if (tag === 'nav' || tag === 'header' || tag === 'aside' || tag === 'footer') return true;
            var role = (p.getAttribute && p.getAttribute('role')) || '';
            if (role === 'navigation' || role === 'banner' || role === 'complementary') return true;
            p = p.parentElement;
          }
          return false;
        }

        function getText(el: any): string {
          return (el.innerText ? el.innerText.trim() : null) || (el.textContent ? el.textContent.trim() : '') || '';
        }

        // <a> 태그 및 UI 크롬 제외, outermost [dir="auto"] 텍스트만 반환
        function getPostTextFromContainer(container: any): string {
          var allDirAutos = Array.from(container.querySelectorAll('[dir="auto"]')) as any[];
          var filtered = allDirAutos.filter(function(el) {
            return !el.closest('a') && !isInUiChrome(el);
          });
          var outermost = filtered.filter(function(el) {
            return !el.parentElement || !el.parentElement.closest('[dir="auto"]');
          });
          return outermost.map(function(el) { return getText(el); }).filter(Boolean).join('\n').trim();
        }

        // span[dir="auto"] 내 텍스트 직접 추출 (새 Threads 구조 대응)
        function getTextFromSpanDirAuto(container: any): string {
          var spans = Array.from(container.querySelectorAll('span[dir="auto"]')) as any[];
          var filtered = spans.filter(function(el) {
            return !el.closest('a') && !isInUiChrome(el);
          });
          var texts = filtered.map(function(el) { return getText(el); }).filter(function(t) { return t.length > 0; });
          if (texts.length === 0) return '';
          // 가장 긴 span 텍스트를 기본으로
          return texts.reduce(function(a: string, b: string) { return b.length > a.length ? b : a; }, '');
        }

        // 텍스트에서 외부 URL 분리
        function extractLinks(text: string): string[] {
          var links: string[] = [];
          var matches = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
          for (var i = 0; i < matches.length; i++) {
            var clean = matches[i].replace(/[.)，,]+$/, '');
            if (!INTERNAL_RE.test(clean) && links.indexOf(clean) === -1) links.push(clean);
          }
          return links;
        }

        function stripUrls(text: string): string {
          return text.replace(/https?:\/\/[^\s"'<>]+/g, '').replace(/\n{3,}/g, '\n\n').trim();
        }

        // ── 본문 추출 (5단계 전략) ────────────────────────────────────────
        var articles = Array.from(document.querySelectorAll('article')).filter(function(el) {
          return !isInUiChrome(el);
        }) as any[];
        var textContent = '';

        // 전략 1: 첫 번째 article의 [dir="auto"]
        if (articles.length > 0) textContent = getPostTextFromContainer(articles[0]);

        // 전략 2: [data-pressable-container] 내부 (새 Threads 컴포넌트 구조)
        if (!textContent || textContent.length < args.minLen) {
          var pressables = Array.from(document.querySelectorAll('[data-pressable-container]'))
            .filter(function(el) { return !isInUiChrome(el); }) as any[];
          if (pressables.length > 0) {
            var candidate = getPostTextFromContainer(pressables[0]);
            if (candidate.length > textContent.length) textContent = candidate;
          }
        }

        // 전략 3: [role="main"] 또는 <main>
        if (!textContent || textContent.length < args.minLen) {
          var mainEl = document.querySelector('[role="main"]') || document.querySelector('main');
          if (mainEl) {
            var candidate = getPostTextFromContainer(mainEl as any);
            if (candidate.length > textContent.length) textContent = candidate;
          }
        }

        // 전략 4: span[dir="auto"] 직접 접근
        if (!textContent || textContent.length < args.minLen) {
          var spanText = getTextFromSpanDirAuto(articles.length > 0 ? articles[0] : document.body);
          if (spanText.length > textContent.length) textContent = spanText;
        }

        // 전략 5: 모든 [dir="auto"] 중 UI 크롬 제외 가장 긴 것
        if (!textContent || textContent.length < args.minLen) {
          var allDirAuto = Array.from(document.querySelectorAll('[dir="auto"]')) as any[];
          var best = textContent;
          for (var i = 0; i < allDirAuto.length; i++) {
            var el = allDirAuto[i] as any;
            if (el.closest('a') || isInUiChrome(el)) continue;
            var t = getText(el);
            if (t.length > best.length) best = t;
          }
          textContent = best;
        }

        // ── 미디어 추출 ───────────────────────────────────────────────────
        var mediaUrls: string[] = [];
        var scope: any = articles.length > 0 ? articles[0] : document.body;

        var imgs = scope.querySelectorAll('img');
        for (var i = 0; i < imgs.length; i++) {
          var imgEl = imgs[i];
          var srcset = imgEl.getAttribute('srcset') || '';
          var src = '';
          if (srcset) {
            var entries = srcset.split(',').map(function(s: string) {
              var parts = s.trim().split(/\s+/);
              return { url: parts[0] || '', width: parseInt(parts[1] || '0', 10) };
            });
            entries.sort(function(a: any, b: any) { return b.width - a.width; });
            src = (entries[0] && entries[0].url) ? entries[0].url : (imgEl.src || '');
          } else {
            src = imgEl.src || imgEl.getAttribute('src') || '';
          }
          var isCdn = src.includes('cdninstagram.com') || src.includes('fbcdn.net');
          var isNotThumb = !src.includes('s150x150') && !src.includes('_s.jpg') && !src.includes('150x150');
          if (src && isCdn && isNotThumb && mediaUrls.indexOf(src) === -1) mediaUrls.push(src);
        }

        var vids = scope.querySelectorAll('video');
        for (var v = 0; v < vids.length; v++) {
          var vid = vids[v];
          var vsrc = vid.src || vid.getAttribute('src') || '';
          if (vsrc && mediaUrls.indexOf(vsrc) === -1) mediaUrls.push(vsrc);
          var sources = vid.querySelectorAll('source');
          for (var s = 0; s < sources.length; s++) {
            var ssrc = sources[s].src || sources[s].getAttribute('src') || '';
            if (ssrc && mediaUrls.indexOf(ssrc) === -1) mediaUrls.push(ssrc);
          }
        }

        // ── 첫 댓글 추출 (텍스트·링크 분리, 5단계 전략) ─────────────────
        var commentText: string | null = null;
        var commentLinks: string[] = [];

        function tryExtractComment(el: any): boolean {
          var raw = getPostTextFromContainer(el);
          if (!raw || raw.length < 5) {
            // [dir="auto"] 방식이 실패하면 span[dir="auto"] 직접 시도
            raw = getTextFromSpanDirAuto(el);
          }
          if (!raw || raw.length < 5) return false;
          var onlyMention = /^(@[\w.]+\s*)+$/.test(raw.trim());
          if (onlyMention) return false;
          if (raw.trim() === textContent.trim()) return false;
          // 본문의 앞부분을 포함하면 동일 포스트로 간주 (중복 방지)
          if (textContent.length > 20 && raw.includes(textContent.slice(0, 20))) return false;
          var anchors = el.querySelectorAll('a[href^="http"]');
          var links: string[] = [];
          for (var a = 0; a < anchors.length; a++) {
            var href = anchors[a].href;
            if (href && !INTERNAL_RE.test(href) && links.indexOf(href) === -1) links.push(href);
          }
          var inTextLinks = extractLinks(raw);
          for (var u = 0; u < inTextLinks.length; u++) {
            if (links.indexOf(inTextLinks[u]) === -1) links.push(inTextLinks[u]);
          }
          commentText = stripUrls(raw) || null;
          commentLinks = links;
          return !!(commentText || links.length);
        }

        // 전략 1: 두 번째 article 이후
        if (articles.length >= 2) {
          for (var ai = 1; ai < articles.length; ai++) {
            if (tryExtractComment(articles[ai])) break;
          }
        }

        // 전략 2: [role="article"]
        if (!commentText && commentLinks.length === 0) {
          var roleArticles = Array.from(document.querySelectorAll('[role="article"]'))
            .filter(function(el) { return !isInUiChrome(el); }) as any[];
          for (var ri = 1; ri < roleArticles.length; ri++) {
            if (tryExtractComment(roleArticles[ri])) break;
          }
        }

        // 전략 3: [data-pressable-container] 두 번째 이후
        if (!commentText && commentLinks.length === 0) {
          var pContainers = Array.from(document.querySelectorAll('[data-pressable-container]'))
            .filter(function(el) { return !isInUiChrome(el); }) as any[];
          for (var pi = 1; pi < pContainers.length; pi++) {
            if (tryExtractComment(pContainers[pi])) break;
          }
        }

        // 전략 4: 본문과 다른 non-anchor [dir="auto"] 블록 (20자 이상, UI 크롬 제외)
        if (!commentText && commentLinks.length === 0) {
          var allNDA = Array.from(document.querySelectorAll('[dir="auto"]')).filter(function(el: any) {
            return !el.closest('a') && !isInUiChrome(el);
          }) as any[];
          for (var di = 0; di < allNDA.length; di++) {
            var dt = getText(allNDA[di]);
            if (dt.length > 20 && dt !== textContent &&
                !(textContent.length > 20 && dt.includes(textContent.slice(0, 20)))) {
              if (!/^(@[\w.]+\s*)+$/.test(dt.trim())) {
                var dtLinks = extractLinks(dt);
                commentText = stripUrls(dt) || null;
                commentLinks = dtLinks;
                break;
              }
            }
          }
        }

        return {
          postUrl: args.url,
          textContent: textContent,
          mediaUrls: mediaUrls,
          commentText: commentText,
          commentLinks: commentLinks,
        };
      }, { url: postUrl, internalPattern: INTERNAL_URL.source, minLen: MIN_TEXT_LEN });

      if (!result.textContent && result.mediaUrls.length === 0) {
        console.log('[Scraper] 콘텐츠를 추출할 수 없습니다. 로그인 상태와 URL을 확인하세요.');
        return null;
      }

      // ── DOM 결과 검증: 본문이 너무 짧으면 경고 ──────────────────────────
      if (result.textContent.length < MIN_TEXT_LEN) {
        console.warn(`[Scraper] ⚠ DOM 본문 짧음 (${result.textContent.length}자) — 미디어만 있거나 텍스트 없는 포스트일 수 있음`);
      }

      console.log(
        `[Scraper] DOM — 본문: ${result.textContent.length}자, ` +
        `미디어: ${result.mediaUrls.length}개, ` +
        `댓글: ${result.commentText ? result.commentText.length + '자' : '없음'}, ` +
        `링크: ${result.commentLinks.length}개`
      );

      return {
        postUrl: result.postUrl,
        textContent: result.textContent,
        mediaUrls: result.mediaUrls,
        commentText: result.commentText ?? undefined,
        commentLinks: result.commentLinks ?? [],
        scrapeMethod: 'dom',
      };
    } finally {
      if (page) await page.close().catch(() => {});
      if (owned) await context.close().catch(() => {});
    }
  }
}

export const threadsScraper = new ThreadsScraper();
