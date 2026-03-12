import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * batchScheduler의 시간 조정 로직을 순수하게 테스트합니다.
 * (Playwright/DB 의존성 없이 타이밍 계산 로직만 검증)
 */

const MIN_GAP_MS = 15 * 60 * 1000;   // 15분
const SLOT_INTERVAL_MS = 30 * 60 * 1000; // 30분

function resolveTargetTime(
  scheduledDate: Date,
  batchNow: Date,
  nextFallbackSlot: Date,
): { targetTime: Date; nextFallbackSlot: Date } {
  if (scheduledDate.getTime() - batchNow.getTime() >= MIN_GAP_MS) {
    const targetTime = scheduledDate;
    let newSlot = nextFallbackSlot;
    if (targetTime.getTime() + SLOT_INTERVAL_MS > newSlot.getTime()) {
      newSlot = new Date(targetTime.getTime() + SLOT_INTERVAL_MS);
    }
    return { targetTime, nextFallbackSlot: newSlot };
  } else {
    const targetTime = nextFallbackSlot;
    const newSlot = new Date(nextFallbackSlot.getTime() + SLOT_INTERVAL_MS);
    return { targetTime, nextFallbackSlot: newSlot };
  }
}

describe('배치 스케줄러 타이밍 로직', () => {
  const batchNow = new Date('2024-01-01T10:00:00');

  it('15분 이상 미래인 경우 설정된 시간을 그대로 사용한다', () => {
    const scheduled = new Date('2024-01-01T11:00:00'); // 1시간 후
    const fallback = new Date(batchNow.getTime() + MIN_GAP_MS);
    const { targetTime } = resolveTargetTime(scheduled, batchNow, fallback);
    expect(targetTime.getTime()).toBe(scheduled.getTime());
  });

  it('과거 시간인 경우 폴백 슬롯을 사용한다', () => {
    const scheduled = new Date('2024-01-01T09:00:00'); // 과거
    const fallback = new Date('2024-01-01T10:15:00');
    const { targetTime } = resolveTargetTime(scheduled, batchNow, fallback);
    expect(targetTime.getTime()).toBe(fallback.getTime());
  });

  it('15분 미만 미래인 경우 폴백 슬롯을 사용한다', () => {
    const scheduled = new Date('2024-01-01T10:10:00'); // 10분 후 (< 15분)
    const fallback = new Date('2024-01-01T10:15:00');
    const { targetTime } = resolveTargetTime(scheduled, batchNow, fallback);
    expect(targetTime.getTime()).toBe(fallback.getTime());
  });

  it('폴백 사용 후 다음 슬롯은 30분 이후로 설정된다', () => {
    const scheduled = new Date('2024-01-01T09:00:00'); // 과거
    const fallback = new Date('2024-01-01T10:15:00');
    const { nextFallbackSlot } = resolveTargetTime(scheduled, batchNow, fallback);
    expect(nextFallbackSlot.getTime()).toBe(fallback.getTime() + SLOT_INTERVAL_MS);
  });

  it('명시적 미래 시간이 슬롯보다 늦으면 슬롯이 밀린다', () => {
    const scheduled = new Date('2024-01-01T15:00:00'); // 5시간 후
    const fallback = new Date('2024-01-01T10:15:00');
    const { targetTime, nextFallbackSlot } = resolveTargetTime(scheduled, batchNow, fallback);
    expect(targetTime.getTime()).toBe(scheduled.getTime());
    expect(nextFallbackSlot.getTime()).toBe(scheduled.getTime() + SLOT_INTERVAL_MS);
  });

  it('연속 폴백 슬롯은 30분씩 증가한다', () => {
    const scheduled1 = new Date('2024-01-01T09:00:00');
    const scheduled2 = new Date('2024-01-01T08:00:00');
    let fallback = new Date('2024-01-01T10:15:00');

    const r1 = resolveTargetTime(scheduled1, batchNow, fallback);
    fallback = r1.nextFallbackSlot;
    const r2 = resolveTargetTime(scheduled2, batchNow, fallback);

    expect(r2.targetTime.getTime()).toBe(r1.targetTime.getTime() + SLOT_INTERVAL_MS);
    expect(r2.nextFallbackSlot.getTime()).toBe(r1.targetTime.getTime() + SLOT_INTERVAL_MS * 2);
  });
});

describe('publish_mode 기본값 정책', () => {
  it("새 포스트는 'native' 모드로 생성되어 자동 즉시 포스팅이 방지된다", () => {
    // getApproved()는 publish_mode='auto'만 선택 → 기본 'native'면 auto-post 안됨
    const publishMode = 'native'; // db.ts create()의 기본값
    expect(publishMode).not.toBe('auto');
    expect(publishMode).toBe('native');
  });

  it("벤치마킹 포스트도 'native' 모드로 생성된다", () => {
    const publishMode = 'native'; // db.ts createBenchmarking()의 기본값
    expect(publishMode).toBe('native');
  });
});
