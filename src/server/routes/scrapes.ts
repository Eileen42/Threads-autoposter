import { Router } from 'express';
import { scrapesQueries, appSettingsQueries } from '../../storage/db';

const router = Router();

// 스크랩 목록 조회
router.get('/', (req, res) => {
  const { project_id, account_id, limit } = req.query;
  const scrapes = scrapesQueries.getAll({
    project_id: project_id ? Number(project_id) : undefined,
    account_id: account_id ? Number(account_id) : undefined,
    limit: limit ? Number(limit) : 500,
  });
  res.json(scrapes);
});

// 스크랩 단건 조회
router.get('/:id', (req, res) => {
  const scrape = scrapesQueries.getById(req.params.id);
  if (!scrape) return res.status(404).json({ error: '스크랩을 찾을 수 없습니다.' });
  res.json(scrape);
});

// 스크랩 삭제
router.delete('/:id', (req, res) => {
  scrapesQueries.delete(req.params.id);
  res.json({ ok: true });
});

// CSV 내보내기
router.get('/export/csv', (req, res) => {
  const { project_id, account_id } = req.query;
  const scrapes = scrapesQueries.getAll({
    project_id: project_id ? Number(project_id) : undefined,
    account_id: account_id ? Number(account_id) : undefined,
  });

  const escape = (v: any) => {
    const s = String(v ?? '').replace(/"/g, '""');
    return `"${s}"`;
  };

  const headers = ['ID', '스크랩일시', '프로젝트', '계정', '원본URL', '원문', '첫댓글', '미디어URL목록'];
  const rows = scrapes.map(s => [
    s.id,
    s.scraped_at,
    s.project_name || '',
    s.username || '',
    s.source_url,
    s.text_content,
    s.first_comment,
    JSON.parse(s.media_urls || '[]').join(' | '),
  ].map(escape).join(','));

  const csv = [headers.join(','), ...rows].join('\r\n');
  const filename = `scrapes_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv); // BOM for Excel Korean encoding
});

// Google Sheets 웹훅으로 스크랩 전송
router.post('/export/sheets', async (req, res) => {
  const { scrape_ids } = req.body;
  const webhookUrl = appSettingsQueries.get('sheets_webhook_url');
  if (!webhookUrl) {
    return res.status(400).json({ error: 'Google Sheets 웹훅 URL이 설정되지 않았습니다. 설정 탭에서 입력하세요.' });
  }

  const ids: number[] = Array.isArray(scrape_ids) ? scrape_ids : [];
  const scrapes = ids.length > 0
    ? ids.map(id => scrapesQueries.getById(id)).filter(Boolean)
    : scrapesQueries.getAll({ limit: 1000 });

  const rows = scrapes.map(s => ({
    id: s.id,
    scraped_at: s.scraped_at,
    project_name: s.project_name || '',
    username: s.username || '',
    source_username: s.source_username || '',
    source_url: s.source_url,
    text_content: s.text_content,
    first_comment: s.first_comment,
    media_urls: JSON.parse(s.media_urls || '[]').join('\n'),
  }));

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    if (!response.ok) throw new Error(`웹훅 응답 오류: ${response.status}`);
    res.json({ ok: true, sent: rows.length });
  } catch (e: any) {
    res.status(500).json({ error: `Google Sheets 전송 실패: ${e.message}` });
  }
});

// 앱 설정 조회
router.get('/settings/all', (_req, res) => {
  const all = appSettingsQueries.getAll();
  const obj: Record<string, string> = {};
  for (const row of all) obj[row.key] = row.value;
  res.json(obj);
});

// 앱 설정 저장
router.post('/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key가 필요합니다.' });
  appSettingsQueries.set(key, value ?? '');
  res.json({ ok: true });
});

export default router;
