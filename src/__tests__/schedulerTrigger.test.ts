import { describe, it, expect } from 'vitest';

/**
 * 스케줄러 트리거 로직 테스트:
 * - preview_time 매칭 로직
 * - 요일 필터 로직
 * - 중복 벤치마킹 트리거 방지
 */

function shouldTriggerGeneration(rule: { preview_time: string; active_days: number[] }, currentTime: string, today: number): boolean {
  const activeDays = rule.active_days;
  if (!activeDays.includes(today)) return false;
  return rule.preview_time === currentTime;
}

function dedupBenchmarkingTrigger(
  rules: Array<{ project_id: number; preview_time: string; active_days: number[] }>,
  currentTime: string,
  today: number,
): number[] {
  const triggered = new Set<number>();
  for (const rule of rules) {
    if (!rule.active_days.includes(today)) continue;
    if (rule.preview_time === currentTime && !triggered.has(rule.project_id)) {
      triggered.add(rule.project_id);
    }
  }
  return [...triggered];
}

describe('preview_time 트리거 로직', () => {
  it('현재 시간과 preview_time이 일치하면 true를 반환한다', () => {
    const rule = { preview_time: '09:00', active_days: [1, 2, 3, 4, 5] };
    expect(shouldTriggerGeneration(rule, '09:00', 1)).toBe(true);
  });

  it('시간이 다르면 false를 반환한다', () => {
    const rule = { preview_time: '09:00', active_days: [1, 2, 3, 4, 5] };
    expect(shouldTriggerGeneration(rule, '09:01', 1)).toBe(false);
    expect(shouldTriggerGeneration(rule, '08:59', 1)).toBe(false);
  });

  it('오늘이 활성 요일이 아니면 false를 반환한다', () => {
    const rule = { preview_time: '09:00', active_days: [1, 2, 3, 4, 5] }; // 평일만
    expect(shouldTriggerGeneration(rule, '09:00', 6)).toBe(false); // 토요일
    expect(shouldTriggerGeneration(rule, '09:00', 7)).toBe(false); // 일요일
  });

  it('활성 요일이면 true를 반환한다', () => {
    const rule = { preview_time: '14:30', active_days: [6, 7] }; // 주말만
    expect(shouldTriggerGeneration(rule, '14:30', 6)).toBe(true);
    expect(shouldTriggerGeneration(rule, '14:30', 7)).toBe(true);
  });
});

describe('벤치마킹 중복 트리거 방지', () => {
  it('같은 project_id의 여러 rule이 있어도 한 번만 트리거한다', () => {
    const rules = [
      { project_id: 1, preview_time: '09:00', active_days: [1, 2, 3, 4, 5] },
      { project_id: 1, preview_time: '09:00', active_days: [1, 2, 3, 4, 5] }, // 중복
    ];
    const triggered = dedupBenchmarkingTrigger(rules, '09:00', 1);
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toBe(1);
  });

  it('다른 project_id는 각각 트리거된다', () => {
    const rules = [
      { project_id: 1, preview_time: '09:00', active_days: [1] },
      { project_id: 2, preview_time: '09:00', active_days: [1] },
    ];
    const triggered = dedupBenchmarkingTrigger(rules, '09:00', 1);
    expect(triggered).toHaveLength(2);
    expect(triggered).toContain(1);
    expect(triggered).toContain(2);
  });

  it('preview_time이 다른 rule은 현재 시간에 트리거되지 않는다', () => {
    const rules = [
      { project_id: 1, preview_time: '09:00', active_days: [1] },
      { project_id: 2, preview_time: '14:00', active_days: [1] },
    ];
    const triggered = dedupBenchmarkingTrigger(rules, '09:00', 1);
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toBe(1);
  });

  it('오늘 활성화되지 않은 rule은 제외된다', () => {
    const rules = [
      { project_id: 1, preview_time: '09:00', active_days: [1, 2, 3, 4, 5] },
      { project_id: 2, preview_time: '09:00', active_days: [6, 7] }, // 주말만
    ];
    const triggered = dedupBenchmarkingTrigger(rules, '09:00', 1); // 월요일
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toBe(1);
  });
});
