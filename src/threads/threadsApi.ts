/**
 * Threads 공식 Graph API 클라이언트
 * App ID: 932119622652179
 *
 * 포스팅: TEXT / IMAGE / VIDEO / CAROUSEL
 * 댓글: reply_to_id 활용
 * 토큰 갱신: refreshToken()
 *
 * ※ 스크래핑(타계정 공개포스트 읽기)은 공식 API 미지원
 *    → scraper.ts에서 Playwright 네트워크 인터셉션으로 처리
 */

const API_BASE = 'https://graph.threads.net/v1.0';
export const THREADS_APP_ID = '932119622652179';

export interface ApiPostResult {
  success: boolean;
  postId?: string;
  postUrl?: string;
  error?: string;
}

async function apiFetch(url: string, method: 'GET' | 'POST' = 'GET'): Promise<any> {
  const res = await fetch(url, { method });
  const data = await res.json() as any;
  if (!res.ok) {
    const msg = data?.error?.message || data?.error_message || JSON.stringify(data);
    throw new Error(msg);
  }
  return data;
}

/** 컨테이너 생성 → 발행 → permalink 조회 공통 흐름 */
async function createAndPublish(
  userId: string,
  token: string,
  params: Record<string, string>,
  waitMs = 1500,
): Promise<ApiPostResult> {
  const container = await apiFetch(
    `${API_BASE}/${userId}/threads?` + new URLSearchParams(params),
    'POST'
  );
  if (!container?.id) throw new Error('컨테이너 생성 실패');

  // Threads API: 컨테이너 생성 후 약간 대기 권장
  await new Promise(r => setTimeout(r, waitMs));

  const published = await apiFetch(
    `${API_BASE}/${userId}/threads_publish?` + new URLSearchParams({ creation_id: container.id, access_token: token }),
    'POST'
  );
  if (!published?.id) throw new Error('게시 실패');

  const postData = await apiFetch(
    `${API_BASE}/${published.id}?` + new URLSearchParams({ fields: 'id,permalink', access_token: token })
  ).catch(() => null);

  return { success: true, postId: published.id, postUrl: postData?.permalink };
}

/** 미디어 컨테이너 처리 완료 대기 (비디오는 인코딩 시간 필요) */
async function waitForMediaReady(containerId: string, token: string, maxWaitMs = 90000): Promise<void> {
  const interval = 5000;
  const maxTries = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < maxTries; i++) {
    await new Promise(r => setTimeout(r, interval));
    const data = await apiFetch(
      `${API_BASE}/${containerId}?` + new URLSearchParams({ fields: 'status,error_code', access_token: token })
    ).catch(() => null);
    if (data?.status === 'FINISHED') return;
    if (data?.status === 'ERROR') throw new Error(`미디어 처리 실패: code=${data.error_code}`);
  }
  throw new Error('미디어 처리 타임아웃 (90초)');
}

export const threadsApi = {

  /** 내 계정 정보 조회 (토큰 유효성 확인용) */
  async getMe(token: string): Promise<{ id: string; username: string; name: string } | null> {
    try {
      return await apiFetch(
        `${API_BASE}/me?` + new URLSearchParams({ fields: 'id,username,name', access_token: token })
      );
    } catch {
      return null;
    }
  },

  /** 텍스트 포스트 발행 */
  async publishText(userId: string, token: string, text: string): Promise<ApiPostResult> {
    try {
      return await createAndPublish(userId, token, { media_type: 'TEXT', text, access_token: token });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /**
   * 이미지/비디오 포스트 발행
   * ⚠️ mediaPublicUrl은 Threads 서버에서 접근 가능한 공개 URL이어야 함
   *    (로컬 파일 직접 업로드 불가 — ngrok 등 터널 또는 CDN URL 사용)
   */
  async publishMedia(
    userId: string,
    token: string,
    text: string,
    mediaPublicUrl: string,
  ): Promise<ApiPostResult> {
    try {
      const isVideo = /\.(mp4|mov|webm|avi)(\?|$)/i.test(mediaPublicUrl);
      const mediaKey = isVideo ? 'video_url' : 'image_url';

      const container = await apiFetch(
        `${API_BASE}/${userId}/threads?` + new URLSearchParams({
          media_type: isVideo ? 'VIDEO' : 'IMAGE',
          text, [mediaKey]: mediaPublicUrl, access_token: token,
        }),
        'POST'
      );
      if (!container?.id) throw new Error('미디어 컨테이너 생성 실패');

      if (isVideo) await waitForMediaReady(container.id, token);

      await new Promise(r => setTimeout(r, 1500));
      const published = await apiFetch(
        `${API_BASE}/${userId}/threads_publish?` + new URLSearchParams({ creation_id: container.id, access_token: token }),
        'POST'
      );
      if (!published?.id) throw new Error('미디어 게시 실패');

      const postData = await apiFetch(
        `${API_BASE}/${published.id}?` + new URLSearchParams({ fields: 'id,permalink', access_token: token })
      ).catch(() => null);

      return { success: true, postId: published.id, postUrl: postData?.permalink };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /**
   * 다중 이미지 캐러셀 발행
   * ⚠️ mediaPublicUrls은 공개 URL 배열 (2~20개)
   */
  async publishCarousel(
    userId: string,
    token: string,
    text: string,
    mediaPublicUrls: string[],
  ): Promise<ApiPostResult> {
    try {
      const itemIds: string[] = [];
      for (const url of mediaPublicUrls) {
        const isVideo = /\.(mp4|mov|webm|avi)(\?|$)/i.test(url);
        const mediaKey = isVideo ? 'video_url' : 'image_url';
        const item = await apiFetch(
          `${API_BASE}/${userId}/threads?` + new URLSearchParams({
            media_type: isVideo ? 'VIDEO' : 'IMAGE',
            is_carousel_item: 'true',
            [mediaKey]: url, access_token: token,
          }),
          'POST'
        );
        if (!item?.id) throw new Error(`캐러셀 아이템 생성 실패: ${url}`);
        if (isVideo) await waitForMediaReady(item.id, token);
        itemIds.push(item.id);
      }

      return await createAndPublish(userId, token, {
        media_type: 'CAROUSEL',
        text, children: itemIds.join(','), access_token: token,
      }, 2000);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /** 포스트에 댓글(reply) 작성 */
  async createReply(userId: string, token: string, replyToId: string, text: string): Promise<ApiPostResult> {
    try {
      return await createAndPublish(userId, token, {
        media_type: 'TEXT', text, reply_to_id: replyToId, access_token: token,
      });
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  /** 내 포스트 목록 조회 */
  async getMyPosts(userId: string, token: string, limit = 10): Promise<any[]> {
    try {
      const data = await apiFetch(
        `${API_BASE}/${userId}/threads?` + new URLSearchParams({
          fields: 'id,text,media_type,media_url,permalink,timestamp,like_count,replies_count',
          limit: String(limit), access_token: token,
        })
      );
      return data?.data || [];
    } catch {
      return [];
    }
  },

  /**
   * 단기 토큰 → 장기 토큰 교환 (60일 유효)
   * appSecret: 앱 시크릿 (4a3e71e59368b9f35efcace814f98787)
   */
  async exchangeForLongLivedToken(shortLivedToken: string, appSecret: string): Promise<{ token: string; expiresIn: number } | null> {
    try {
      const data = await apiFetch(
        `${API_BASE}/access_token?` + new URLSearchParams({
          grant_type: 'th_exchange_token',
          client_secret: appSecret,
          access_token: shortLivedToken,
        })
      );
      return { token: data.access_token, expiresIn: data.expires_in };
    } catch {
      return null;
    }
  },

  /**
   * 장기 토큰 갱신 (만료 전 갱신, 60일마다 호출)
   */
  async refreshToken(longLivedToken: string): Promise<{ token: string; expiresIn: number } | null> {
    try {
      const data = await apiFetch(
        `${API_BASE}/refresh_access_token?` + new URLSearchParams({
          grant_type: 'th_refresh_token',
          access_token: longLivedToken,
        })
      );
      return { token: data.access_token, expiresIn: data.expires_in };
    } catch {
      return null;
    }
  },
};
