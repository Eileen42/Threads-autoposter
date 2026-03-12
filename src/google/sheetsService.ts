import { google } from 'googleapis';
import { getAuthorizedClient } from './oauthService';
import { appSettingsQueries } from '../storage/db';

export interface ScrapeRow {
  id: number;
  scraped_at: string;
  project_name: string;
  username: string;
  source_url: string;
  source_username: string;
  text_content: string;
  first_comment: string;
  media_urls: string;
}

const HEADER_ROW = ['ID', '스크랩일시', '프로젝트', '내 계정', '원본 계정', '원본 URL', '원문 본문', '첫 댓글', '미디어 URL 목록', '로컬 미디어 경로'];

export async function appendScrapeRows(rows: ScrapeRow[]): Promise<{ updated: number }> {
  const auth = getAuthorizedClient();
  if (!auth) throw new Error('Google 계정이 연결되지 않았습니다. 설정에서 Google 로그인을 먼저 하세요.');

  const spreadsheetId = appSettingsQueries.get('google_spreadsheet_id');
  if (!spreadsheetId) throw new Error('Google Sheets 스프레드시트 ID가 설정되지 않았습니다.');

  const sheetName = appSettingsQueries.get('google_sheet_name') || '스크랩데이터';
  const sheets = google.sheets({ version: 'v4', auth });

  // 시트 존재 확인 + 헤더 없으면 추가
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetExists = spreadsheet.data.sheets?.some(
    s => s.properties?.title === sheetName
  );

  if (!sheetExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          addSheet: { properties: { title: sheetName } },
        }],
      },
    });
    // 헤더 추가
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADER_ROW] },
    });
  } else {
    // 헤더 있는지 확인
    const header = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A1:J1`,
    });
    if (!header.data.values || header.data.values.length === 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [HEADER_ROW] },
      });
    }
  }

  // 데이터 추가
  const valueRows = rows.map(r => [
    r.id,
    r.scraped_at,
    r.project_name || '',
    r.username ? '@' + r.username : '',
    r.source_username ? '@' + r.source_username : '',
    r.source_url,
    r.text_content,
    r.first_comment,
    r.media_urls,
    '',
  ]);

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: valueRows },
  });

  return { updated: valueRows.length };
}

export async function getSpreadsheetTitle(spreadsheetId: string): Promise<string> {
  const auth = getAuthorizedClient();
  if (!auth) throw new Error('Google 계정이 연결되지 않았습니다.');
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.get({ spreadsheetId });
  return res.data.properties?.title || spreadsheetId;
}
