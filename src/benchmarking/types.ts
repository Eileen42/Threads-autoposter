export interface TargetAccount {
  url: string;      // e.g. https://www.threads.net/@username
  enabled: boolean;
}

/** Post card extracted from a profile page (with engagement data if available) */
export interface PostCard {
  url: string;
  viewCount: number; // 0 if view count could not be extracted
}

export interface ScrapedPost {
  postUrl: string;
  textContent: string;
  mediaUrls: string[];
  commentText?: string;   // 첫 댓글 순수 텍스트 (URL 제거)
  commentLinks: string[]; // 첫 댓글에서 추출한 외부 링크 목록
  scrapeMethod?: 'api' | 'dom'; // 스크랩 방식 (로깅용)
}

export type BenchmarkJobStatus =
  | 'pending'
  | 'scraping'
  | 'rewriting'
  | 'posting'
  | 'done'
  | 'failed';
