import { Page } from 'playwright';

// ─── 랜덤 딜레이 ──────────────────────────────────────────────────────────────
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 짧은 딜레이 (클릭 후, 입력 전)
export async function shortDelay(): Promise<void> {
  await sleep(randomInt(300, 800));
}

// 보통 딜레이 (페이지 이동 후, 요소 로드 대기)
export async function mediumDelay(): Promise<void> {
  await sleep(randomInt(800, 2000));
}

// 긴 딜레이 (포스팅 사이, 자연스러운 읽기 시간)
export async function longDelay(): Promise<void> {
  await sleep(randomInt(2000, 5000));
}

// ─── 사람처럼 타이핑 (이미 포커스된 요소에 - 클릭 없음) ─────────────────────
export async function humanTypeText(page: Page, text: string): Promise<void> {
  // for...of로 유니코드 코드포인트 단위 순회 (text[i]는 UTF-16 코드유닛 → 이모지 surrogate pair 깨짐)
  for (const char of text) {
    await page.keyboard.type(char);

    let delay = randomInt(40, 120);
    if (['.', '!', '?', '\n'].includes(char)) {
      delay += randomInt(100, 400);
    } else if ([',', ';'].includes(char)) {
      delay += randomInt(50, 150);
    }
    if (Math.random() < 0.03) {
      delay += randomInt(500, 1500);
    }
    await sleep(delay);
  }
}

// ─── 사람처럼 타이핑 (CSS 셀렉터로 클릭 후 타이핑) ────────────────────────
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  await shortDelay();
  await humanTypeText(page, text);
}

// ─── 사람처럼 클릭 (약간 랜덤한 위치) ───────────────────────────────────────
export async function humanClick(page: Page, selector: string): Promise<void> {
  const element = await page.waitForSelector(selector, { timeout: 10000 });
  if (!element) throw new Error(`Element not found: ${selector}`);

  const box = await element.boundingBox();
  if (!box) {
    await element.click();
    return;
  }

  // 요소 중심에서 ±20% 랜덤한 위치 클릭
  const offsetX = (Math.random() - 0.5) * box.width * 0.4;
  const offsetY = (Math.random() - 0.5) * box.height * 0.4;
  const x = box.x + box.width / 2 + offsetX;
  const y = box.y + box.height / 2 + offsetY;

  // 클릭 전 잠깐 마우스 이동 (더 자연스럽게)
  await page.mouse.move(x + randomInt(-10, 10), y + randomInt(-5, 5));
  await sleep(randomInt(50, 150));
  await page.mouse.click(x, y);
}

// ─── 자연스러운 스크롤 ────────────────────────────────────────────────────────
export async function humanScroll(page: Page, direction: 'down' | 'up' = 'down'): Promise<void> {
  const steps = randomInt(2, 5);
  for (let i = 0; i < steps; i++) {
    const amount = randomInt(100, 300) * (direction === 'down' ? 1 : -1);
    await page.mouse.wheel(0, amount);
    await sleep(randomInt(200, 600));
  }
}

// ─── 포스팅 전 읽기 시뮬레이션 ───────────────────────────────────────────────
export async function simulateReading(page: Page): Promise<void> {
  // 페이지 로드 후 잠깐 가만히 있기
  await sleep(randomInt(1000, 2500));
  // 약간 스크롤
  await humanScroll(page, 'down');
  await sleep(randomInt(500, 1500));
  // 다시 위로 스크롤
  await humanScroll(page, 'up');
  await sleep(randomInt(800, 2000));
}

// ─── 스케줄 타이밍에 랜덤 변형 추가 (정확히 같은 시간 방지) ────────────────
export function addTimingVariance(scheduledTime: Date, varianceMinutes: number): Date {
  const variance = randomInt(-varianceMinutes * 60 * 1000, varianceMinutes * 60 * 1000);
  return new Date(scheduledTime.getTime() + variance);
}

// ─── 오늘 날짜/요일 체크 ─────────────────────────────────────────────────────
export function getTodayDayNumber(): number {
  // 1=월요일, 7=일요일
  const day = new Date().getDay();
  return day === 0 ? 7 : day;
}

export function parseTimeToToday(timeStr: string): Date {
  // timeStr: "HH:MM"
  const [hours, minutes] = timeStr.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date;
}
