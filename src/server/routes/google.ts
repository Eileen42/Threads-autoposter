import { Router } from 'express';
import { getAuthUrl, exchangeCode, isAuthenticated, revokeAuth } from '../../google/oauthService';
import { appendScrapeRows } from '../../google/sheetsService';
import { appSettingsQueries, scrapesQueries } from '../../storage/db';

const router = Router();

// Google OAuth 상태 조회
router.get('/status', (_req, res) => {
  const authenticated = isAuthenticated();
  const spreadsheetId = appSettingsQueries.get('google_spreadsheet_id');
  const sheetName = appSettingsQueries.get('google_sheet_name') || '스크랩데이터';
  const hasCredentials = !!(appSettingsQueries.get('google_client_id') && appSettingsQueries.get('google_client_secret'));
  res.json({ authenticated, spreadsheetId, sheetName, hasCredentials });
});

// OAuth 클라이언트 자격증명 저장
router.post('/credentials', (req, res) => {
  const { client_id, client_secret } = req.body;
  if (!client_id || !client_secret) {
    return res.status(400).json({ error: 'client_id와 client_secret이 필요합니다.' });
  }
  appSettingsQueries.set('google_client_id', client_id.trim());
  appSettingsQueries.set('google_client_secret', client_secret.trim());
  res.json({ ok: true });
});

// Google 로그인 URL 생성 → 브라우저에서 열기
router.get('/auth-url', (_req, res) => {
  const url = getAuthUrl();
  if (!url) return res.status(400).json({ error: 'Client ID/Secret이 설정되지 않았습니다.' });
  res.json({ url });
});

// OAuth 콜백 (Google이 코드와 함께 리다이렉트)
router.get('/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send('인증 코드가 없습니다.');
  try {
    await exchangeCode(code);
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0f0f0f;color:#e8e8e8;text-align:center">
        <h2 style="color:#22c55e">Google 계정 연결 완료!</h2>
        <p>이 창을 닫고 앱으로 돌아가세요.</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>
    `);
  } catch (e: any) {
    res.status(500).send(`인증 실패: ${e.message}`);
  }
});

// Google 로그아웃
router.post('/revoke', (_req, res) => {
  revokeAuth();
  res.json({ ok: true });
});

// Spreadsheet 설정 저장
router.post('/settings', (req, res) => {
  const { spreadsheet_id, sheet_name } = req.body;
  if (spreadsheet_id !== undefined) appSettingsQueries.set('google_spreadsheet_id', spreadsheet_id);
  if (sheet_name !== undefined) appSettingsQueries.set('google_sheet_name', sheet_name || '스크랩데이터');
  res.json({ ok: true });
});

// 스크랩 데이터를 Google Sheets에 전송
router.post('/sheets/append', async (req, res) => {
  try {
    const { scrape_ids } = req.body;
    const ids: number[] = Array.isArray(scrape_ids) ? scrape_ids : [];

    const scrapes = ids.length > 0
      ? ids.map(id => scrapesQueries.getById(id)).filter(Boolean)
      : scrapesQueries.getAll({ limit: 1000 });

    const rows = scrapes.map((s: any) => ({
      id: s.id,
      scraped_at: s.scraped_at,
      project_name: s.project_name || '',
      username: s.username || '',
      source_url: s.source_url,
      source_username: s.source_username || '',
      text_content: s.text_content,
      first_comment: s.first_comment,
      media_urls: JSON.parse(s.media_urls || '[]').join('\n'),
    }));

    const result = await appendScrapeRows(rows);
    res.json({ ok: true, updated: result.updated });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
