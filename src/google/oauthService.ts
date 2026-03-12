import { google, Auth } from 'googleapis';
import { appSettingsQueries } from '../storage/db';

const REDIRECT_URI = 'http://localhost:4000/api/google/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

export function getCredentials(): { client_id: string; client_secret: string } | null {
  const client_id = appSettingsQueries.get('google_client_id');
  const client_secret = appSettingsQueries.get('google_client_secret');
  if (!client_id || !client_secret) return null;
  return { client_id, client_secret };
}

export function createOAuth2Client(): Auth.OAuth2Client | null {
  const creds = getCredentials();
  if (!creds) return null;
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, REDIRECT_URI);
}

export function getAuthUrl(): string | null {
  const oauth2Client = createOAuth2Client();
  if (!oauth2Client) return null;
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function exchangeCode(code: string): Promise<boolean> {
  const oauth2Client = createOAuth2Client();
  if (!oauth2Client) return false;
  const { tokens } = await oauth2Client.getToken(code);
  appSettingsQueries.set('google_access_token', tokens.access_token || '');
  appSettingsQueries.set('google_refresh_token', tokens.refresh_token || '');
  appSettingsQueries.set('google_token_expiry', String(tokens.expiry_date || ''));
  return true;
}

export function getAuthorizedClient(): Auth.OAuth2Client | null {
  const oauth2Client = createOAuth2Client();
  if (!oauth2Client) return null;
  const access_token = appSettingsQueries.get('google_access_token');
  const refresh_token = appSettingsQueries.get('google_refresh_token');
  const expiry_date = appSettingsQueries.get('google_token_expiry');
  if (!refresh_token) return null;
  oauth2Client.setCredentials({
    access_token: access_token || undefined,
    refresh_token,
    expiry_date: expiry_date ? Number(expiry_date) : undefined,
  });
  // 토큰 갱신 시 DB에 자동 저장
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.access_token) appSettingsQueries.set('google_access_token', tokens.access_token);
    if (tokens.expiry_date) appSettingsQueries.set('google_token_expiry', String(tokens.expiry_date));
  });
  return oauth2Client;
}

export function isAuthenticated(): boolean {
  return !!appSettingsQueries.get('google_refresh_token');
}

export function revokeAuth(): void {
  appSettingsQueries.set('google_access_token', '');
  appSettingsQueries.set('google_refresh_token', '');
  appSettingsQueries.set('google_token_expiry', '');
}
