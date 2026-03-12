import { describe, it, expect } from 'vitest';
import { separateTextAndLinks, isOnlyMentions } from '../benchmarking/scraper';

describe('separateTextAndLinks', () => {
  it('외부 URL을 링크로 분리하고 텍스트에서 제거한다', () => {
    const raw = '좋은 상품입니다 https://coupang.com/product/123 추천해요';
    const { text, links } = separateTextAndLinks(raw);
    expect(links).toContain('https://coupang.com/product/123');
    expect(text).not.toContain('https://');
    expect(text).toContain('좋은 상품입니다');
    expect(text).toContain('추천해요');
  });

  it('Threads 내부 URL은 링크 목록에서 제외한다', () => {
    const raw = '팔로우 해주세요 https://www.threads.net/@username';
    const { links } = separateTextAndLinks(raw);
    expect(links).toHaveLength(0);
  });

  it('URL 뒤 구두점을 제거한다', () => {
    const raw = '링크: https://example.com/page.';
    const { links } = separateTextAndLinks(raw);
    expect(links[0]).not.toMatch(/\.$/);
    expect(links[0]).toBe('https://example.com/page');
  });

  it('여러 URL을 모두 추출한다', () => {
    const raw = '첫 번째 https://a.com 두 번째 https://b.com';
    const { links } = separateTextAndLinks(raw);
    expect(links).toHaveLength(2);
    expect(links).toContain('https://a.com');
    expect(links).toContain('https://b.com');
  });

  it('중복 URL은 한 번만 포함한다', () => {
    const raw = 'https://a.com 반복 https://a.com';
    const { links } = separateTextAndLinks(raw);
    expect(links.filter(l => l === 'https://a.com')).toHaveLength(1);
  });

  it('URL이 없으면 원본 텍스트를 그대로 반환하고 빈 링크 배열을 반환한다', () => {
    const raw = '텍스트만 있는 내용입니다.';
    const { text, links } = separateTextAndLinks(raw);
    expect(text).toBe(raw);
    expect(links).toHaveLength(0);
  });

  it('빈 문자열 처리', () => {
    const { text, links } = separateTextAndLinks('');
    expect(text).toBe('');
    expect(links).toHaveLength(0);
  });

  it('연속 빈 줄을 최대 2줄로 압축한다', () => {
    const raw = '첫 줄\n\n\n\n두 번째 줄';
    const { text } = separateTextAndLinks(raw);
    expect(text).not.toMatch(/\n{3,}/);
    expect(text).toContain('첫 줄');
    expect(text).toContain('두 번째 줄');
  });
});

describe('isOnlyMentions', () => {
  it('@mention만 있으면 true를 반환한다', () => {
    expect(isOnlyMentions('@user1')).toBe(true);
    expect(isOnlyMentions('@user1 @user2')).toBe(true);
    expect(isOnlyMentions('@user.name')).toBe(true);
  });

  it('일반 텍스트가 포함되면 false를 반환한다', () => {
    expect(isOnlyMentions('@user 안녕하세요')).toBe(false);
    expect(isOnlyMentions('안녕 @user')).toBe(false);
    expect(isOnlyMentions('일반 텍스트')).toBe(false);
  });

  it('빈 문자열은 false를 반환한다', () => {
    expect(isOnlyMentions('')).toBe(false);
  });

  it('앞뒤 공백을 무시한다', () => {
    expect(isOnlyMentions('  @user1  ')).toBe(true);
  });
});
