import path from 'path';
import fs from 'fs';

// Tracks scraped post URLs per target account URL (keeps last 50 to avoid re-scraping)
// Stored in data/last_scraped.json as { "https://threads.net/@x": ["https://threads.net/@x/post/ID", ...] }

const STATE_PATH = path.join(process.cwd(), 'data', 'last_scraped.json');
const MAX_PER_TARGET = 50;

type ScrapedState = Record<string, string[]>;

function load(): ScrapedState {
  try {
    if (!fs.existsSync(STATE_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    // Migrate from old format (string → string[])
    const result: ScrapedState = {};
    for (const [k, v] of Object.entries(raw)) {
      result[k] = Array.isArray(v) ? v : [v as string];
    }
    return result;
  } catch {
    return {};
  }
}

function save(state: ScrapedState): void {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

export function isAlreadyScraped(accountUrl: string, postUrl: string): boolean {
  const state = load();
  return (state[accountUrl] || []).includes(postUrl);
}

export function markScraped(accountUrl: string, postUrl: string): void {
  const state = load();
  const existing = state[accountUrl] || [];
  if (!existing.includes(postUrl)) {
    existing.unshift(postUrl); // newest first
    state[accountUrl] = existing.slice(0, MAX_PER_TARGET);
  }
  save(state);
}
