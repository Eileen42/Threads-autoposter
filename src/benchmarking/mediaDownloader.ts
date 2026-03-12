import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';

export const TEMP_MEDIA_DIR = path.join(process.cwd(), 'temp_media');

export function ensureTempDir(): void {
  if (!fs.existsSync(TEMP_MEDIA_DIR)) {
    fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
  }
}

/**
 * Downloads a single file via HTTP/HTTPS to the temp_media directory.
 * Follows redirects automatically.
 */
export async function downloadFile(url: string, filename: string): Promise<string> {
  ensureTempDir();
  const filePath = path.join(TEMP_MEDIA_DIR, filename);

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const fileStream = fs.createWriteStream(filePath);

    const cleanup = () => {
      fileStream.close();
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    };

    const request = protocol.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://www.threads.net/',
        },
      },
      response => {
        // Follow redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) { cleanup(); reject(new Error('Redirect without location header')); return; }
          fileStream.close();
          fs.unlink(filePath, () => {});
          resolve(downloadFile(redirectUrl, filename));
          return;
        }
        if (response.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }
        response.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close(() => resolve(filePath));
        });
      }
    );

    request.on('error', err => { cleanup(); reject(err); });
    fileStream.on('error', err => { cleanup(); reject(err); });
  });
}

/** Returns YYMMDD date prefix (e.g. "260305" for 2026-03-05) */
function datePart(): string {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/** Sanitizes a string for use as a filename keyword */
function sanitizeKeyword(raw: string): string {
  return raw
    .replace(/https?:\/\/[^\s]*/g, '') // remove URLs
    .replace(/[^a-zA-Z0-9가-힣_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 30)
    .replace(/^_|_$/g, '') || 'media';
}

/**
 * Downloads all media URLs to temp_media/.
 * Filenames follow the format: YYMMDD_keyword_N.ext
 * Skips URLs that fail without throwing; logs warnings.
 */
export async function downloadMediaFiles(urls: string[], keyword = 'media'): Promise<string[]> {
  const downloaded: string[] = [];
  const date = datePart();
  const kw = sanitizeKeyword(keyword);

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      let ext = '.jpg';
      try {
        const urlPath = new URL(url).pathname;
        const rawExt = path.extname(urlPath);
        if (rawExt) ext = rawExt.split('?')[0];
      } catch { /* malformed URL */ }

      const filename = `${date}_${kw}_${i + 1}${ext}`;
      console.log(`[Downloader] 다운로드 (${i + 1}/${urls.length}): ${url.slice(0, 80)}...`);

      const filePath = await downloadFile(url, filename);
      downloaded.push(filePath);
      console.log(`[Downloader] 완료: ${path.basename(filePath)} (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.warn(`[Downloader] 실패 (건너뜀): ${url.slice(0, 80)} — ${err}`);
    }
  }

  return downloaded;
}

const MEDIA_BASE_DIR = path.join(process.cwd(), 'data', 'media');

/**
 * Moves downloaded temp files to data/media/{postId}/.
 * Returns URL paths like /media/{postId}/filename.jpg
 */
export function moveToPostMedia(tempPaths: string[], postId: number): string[] {
  const destDir = path.join(MEDIA_BASE_DIR, String(postId));
  fs.mkdirSync(destDir, { recursive: true });
  const urlPaths: string[] = [];
  for (const src of tempPaths) {
    if (!fs.existsSync(src)) continue;
    const filename = path.basename(src);
    const dest = path.join(destDir, filename);
    try {
      fs.renameSync(src, dest);
      urlPaths.push(`/media/${postId}/${filename}`);
    } catch {
      try {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
        urlPaths.push(`/media/${postId}/${filename}`);
      } catch (err) {
        console.warn(`[Downloader] 미디어 이동 실패 (${filename}):`, err);
      }
    }
  }
  return urlPaths;
}

/**
 * Removes the data/media/{postId}/ directory and all its contents.
 */
export function cleanupPostMedia(postId: number): void {
  const dir = path.join(MEDIA_BASE_DIR, String(postId));
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[Downloader] 포스트 미디어 정리 완료: post #${postId}`);
    }
  } catch (err) {
    console.error('[Downloader] 포스트 미디어 정리 오류:', err);
  }
}

/**
 * Deletes all files inside temp_media/. Does NOT remove the directory itself.
 */
export function cleanupTempMedia(): void {
  try {
    if (!fs.existsSync(TEMP_MEDIA_DIR)) return;
    const files = fs.readdirSync(TEMP_MEDIA_DIR);
    let deleted = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(TEMP_MEDIA_DIR, file));
        deleted++;
      } catch { /* ignore locked files */ }
    }
    if (deleted > 0) {
      console.log(`[Downloader] temp_media 정리 완료 (${deleted}개 파일 삭제)`);
    }
  } catch (err) {
    console.error('[Downloader] 임시 파일 정리 오류:', err);
  }
}
