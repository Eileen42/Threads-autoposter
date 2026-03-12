import { describe, it, expect } from 'vitest';
import {
  randomInt,
  addTimingVariance,
  getTodayDayNumber,
  parseTimeToToday,
} from '../human/humanBehavior';

describe('randomInt', () => {
  it('min과 max 사이의 정수를 반환한다', () => {
    for (let i = 0; i < 100; i++) {
      const result = randomInt(1, 10);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(10);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it('min === max이면 항상 같은 값을 반환한다', () => {
    expect(randomInt(5, 5)).toBe(5);
  });
});

describe('addTimingVariance', () => {
  it('지정된 분 범위 내에서 시간을 조정한다', () => {
    const base = new Date('2024-01-01T12:00:00');
    const varianceMinutes = 10;
    const maxDiffMs = varianceMinutes * 60 * 1000;

    for (let i = 0; i < 50; i++) {
      const result = addTimingVariance(base, varianceMinutes);
      const diff = Math.abs(result.getTime() - base.getTime());
      expect(diff).toBeLessThanOrEqual(maxDiffMs);
    }
  });

  it('varianceMinutes=0이면 원래 시간을 반환한다', () => {
    const base = new Date('2024-01-01T12:00:00');
    const result = addTimingVariance(base, 0);
    expect(result.getTime()).toBe(base.getTime());
  });
});

describe('getTodayDayNumber', () => {
  it('1(월요일)~7(일요일) 사이의 값을 반환한다', () => {
    const day = getTodayDayNumber();
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(7);
  });

  it('일요일(0)을 7로 변환한다', () => {
    const origGetDay = Date.prototype.getDay;
    Date.prototype.getDay = () => 0;
    expect(getTodayDayNumber()).toBe(7);
    Date.prototype.getDay = origGetDay;
  });

  it('월요일(1)은 1을 반환한다', () => {
    const origGetDay = Date.prototype.getDay;
    Date.prototype.getDay = () => 1;
    expect(getTodayDayNumber()).toBe(1);
    Date.prototype.getDay = origGetDay;
  });
});

describe('parseTimeToToday', () => {
  it('"HH:MM" 형식을 오늘 날짜의 Date로 파싱한다', () => {
    const result = parseTimeToToday('14:30');
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
  });

  it('오늘 날짜를 기반으로 한다', () => {
    const today = new Date();
    const result = parseTimeToToday('09:00');
    expect(result.getFullYear()).toBe(today.getFullYear());
    expect(result.getMonth()).toBe(today.getMonth());
    expect(result.getDate()).toBe(today.getDate());
  });

  it('자정("00:00") 파싱', () => {
    const result = parseTimeToToday('00:00');
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  it('23:59 파싱', () => {
    const result = parseTimeToToday('23:59');
    expect(result.getHours()).toBe(23);
    expect(result.getMinutes()).toBe(59);
  });
});
