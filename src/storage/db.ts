// Node.js 22.5.0+ 내장 SQLite 사용 (별도 설치 불필요)
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'autoposter.db');
export const db = new DatabaseSync(DB_PATH);

export function initDB() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      profile_dir TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      ai_type TEXT NOT NULL DEFAULT 'claude',
      url TEXT NOT NULL,
      prompt_template TEXT NOT NULL DEFAULT '',
      profile_dir TEXT NOT NULL,
      input_selector TEXT DEFAULT '',
      submit_selector TEXT DEFAULT '',
      output_selector TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS post_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT '기본 템플릿',
      main_prompt TEXT NOT NULL DEFAULT '',
      comment_template TEXT DEFAULT '',
      hashtags TEXT DEFAULT '[]',
      link_url TEXT DEFAULT '',
      link_label TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedule_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      ai_config_id INTEGER NOT NULL,
      template_id INTEGER NOT NULL,
      preview_time TEXT NOT NULL DEFAULT '09:00',
      post_times TEXT NOT NULL DEFAULT '["18:00"]',
      active_days TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
      timing_variance_min INTEGER DEFAULT 5,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (ai_config_id) REFERENCES ai_configs(id) ON DELETE CASCADE,
      FOREIGN KEY (template_id) REFERENCES post_templates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER,
      project_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      ai_config_id INTEGER NOT NULL,
      template_id INTEGER NOT NULL,
      generated_content TEXT DEFAULT '',
      comment_content TEXT DEFAULT '',
      scheduled_time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_generation',
      approved_at TEXT,
      posted_at TEXT,
      post_url TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS post_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES scheduled_posts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS benchmarking_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_account TEXT NOT NULL,
      source_post_url TEXT NOT NULL,
      original_content TEXT DEFAULT '',
      rewritten_content TEXT DEFAULT '',
      media_paths TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      posted_url TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      posted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS project_benchmarking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL UNIQUE,
      is_enabled INTEGER DEFAULT 0,
      interval_hours INTEGER DEFAULT 6,
      posting_account_id INTEGER,
      ai_config_id INTEGER,
      rewrite_prompt TEXT DEFAULT '',
      targets TEXT DEFAULT '[]',
      last_checked_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scrapes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      account_id INTEGER,
      source_url TEXT NOT NULL DEFAULT '',
      source_username TEXT DEFAULT '',
      scraped_at TEXT DEFAULT (datetime('now')),
      text_content TEXT DEFAULT '',
      first_comment TEXT DEFAULT '',
      media_urls TEXT DEFAULT '[]',
      media_local_paths TEXT DEFAULT '[]',
      linked_post_id INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
  `);

  // Migrations: add new columns if they don't exist yet (try/catch = idempotent)
  const migrations = [
    `ALTER TABLE scheduled_posts ADD COLUMN source_type TEXT DEFAULT 'scheduled'`,
    `ALTER TABLE scheduled_posts ADD COLUMN source_url TEXT DEFAULT ''`,
    `ALTER TABLE scheduled_posts ADD COLUMN media_paths TEXT DEFAULT '[]'`,
    `ALTER TABLE scheduled_posts ADD COLUMN original_content TEXT DEFAULT ''`,
    // Threads API 토큰 지원
    `ALTER TABLE accounts ADD COLUMN access_token TEXT DEFAULT ''`,
    `ALTER TABLE accounts ADD COLUMN threads_user_id TEXT DEFAULT ''`,
    `ALTER TABLE accounts ADD COLUMN token_expires_at TEXT DEFAULT ''`,
    // 발행 방식: 'auto'(지정시간 자동발행) | 'native'(Threads 네이티브 예약, 수동 배치)
    `ALTER TABLE scheduled_posts ADD COLUMN publish_mode TEXT DEFAULT 'auto'`,
    // 벤치마킹 워크플로우 개선: 원본댓글/링크 분리 저장, 타겟당 스크랩 수
    `ALTER TABLE scheduled_posts ADD COLUMN original_comment TEXT DEFAULT ''`,
    `ALTER TABLE scheduled_posts ADD COLUMN comment_links TEXT DEFAULT '[]'`,
    `ALTER TABLE scrapes ADD COLUMN comment_links TEXT DEFAULT '[]'`,
    `ALTER TABLE project_benchmarking ADD COLUMN posts_per_run INTEGER DEFAULT 1`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  console.log('✅ DB 초기화 완료:', DB_PATH);
}

// ─── Projects ─────────────────────────────────────────────────────────────────
export const projectQueries = {
  getAll: () => db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as any[],
  getById: (id: any) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any,
  create: (data: any) => db.prepare(`INSERT INTO projects (name, description) VALUES (?, ?)`).run(data.name, data.description),
  update: (data: any) => db.prepare(`UPDATE projects SET name=?, description=?, is_active=? WHERE id=?`).run(data.name, data.description, data.is_active, data.id),
  delete: (id: any) => db.prepare('DELETE FROM projects WHERE id = ?').run(id),
};

// ─── Accounts ─────────────────────────────────────────────────────────────────
export const accountQueries = {
  getByProject: (projectId: any) => db.prepare('SELECT * FROM accounts WHERE project_id = ? ORDER BY id').all(projectId) as any[],
  getById: (id: any) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as any,
  create: (data: any) => db.prepare(`INSERT INTO accounts (project_id, username, display_name, profile_dir) VALUES (?, ?, ?, ?)`).run(data.project_id, data.username, data.display_name, data.profile_dir),
  update: (data: any) => db.prepare(`UPDATE accounts SET username=?, display_name=?, is_active=? WHERE id=?`).run(data.username, data.display_name, data.is_active, data.id),
  setToken: (id: any, data: { access_token: string; threads_user_id: string; token_expires_at?: string }) =>
    db.prepare(`UPDATE accounts SET access_token=?, threads_user_id=?, token_expires_at=? WHERE id=?`)
      .run(data.access_token, data.threads_user_id, data.token_expires_at || '', id),
  clearToken: (id: any) => db.prepare(`UPDATE accounts SET access_token='', threads_user_id='', token_expires_at='' WHERE id=?`).run(id),
  delete: (id: any) => db.prepare('DELETE FROM accounts WHERE id = ?').run(id),
};

// ─── AI Configs ───────────────────────────────────────────────────────────────
export const aiConfigQueries = {
  getByProject: (projectId: any) => db.prepare('SELECT * FROM ai_configs WHERE project_id = ? ORDER BY id').all(projectId) as any[],
  getById: (id: any) => db.prepare('SELECT * FROM ai_configs WHERE id = ?').get(id) as any,
  create: (data: any) => db.prepare(`INSERT INTO ai_configs (project_id, name, ai_type, url, prompt_template, profile_dir, input_selector, submit_selector, output_selector) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(data.project_id, data.name, data.ai_type, data.url, data.prompt_template, data.profile_dir, data.input_selector, data.submit_selector, data.output_selector),
  update: (data: any) => db.prepare(`UPDATE ai_configs SET name=?, ai_type=?, url=?, prompt_template=?, input_selector=?, submit_selector=?, output_selector=?, is_active=? WHERE id=?`).run(data.name, data.ai_type, data.url, data.prompt_template, data.input_selector, data.submit_selector, data.output_selector, data.is_active, data.id),
  delete: (id: any) => db.prepare('DELETE FROM ai_configs WHERE id = ?').run(id),
};

// ─── Post Templates ───────────────────────────────────────────────────────────
export const templateQueries = {
  getByProject: (projectId: any) => db.prepare('SELECT * FROM post_templates WHERE project_id = ? ORDER BY id').all(projectId) as any[],
  getById: (id: any) => db.prepare('SELECT * FROM post_templates WHERE id = ?').get(id) as any,
  create: (data: any) => db.prepare(`INSERT INTO post_templates (project_id, name, main_prompt, comment_template, hashtags) VALUES (?, ?, ?, ?, ?)`).run(data.project_id, data.name, data.main_prompt, data.comment_template, data.hashtags),
  update: (data: any) => db.prepare(`UPDATE post_templates SET name=?, main_prompt=?, comment_template=?, hashtags=?, is_active=? WHERE id=?`).run(data.name, data.main_prompt, data.comment_template, data.hashtags, data.is_active, data.id),
  delete: (id: any) => db.prepare('DELETE FROM post_templates WHERE id = ?').run(id),
};

// ─── Schedule Rules ───────────────────────────────────────────────────────────
export const scheduleRuleQueries = {
  getAll: () => db.prepare(`
    SELECT r.*, p.name as project_name, a.username, ai.name as ai_name, t.name as template_name
    FROM schedule_rules r
    JOIN projects p ON r.project_id = p.id
    JOIN accounts a ON r.account_id = a.id
    JOIN ai_configs ai ON r.ai_config_id = ai.id
    JOIN post_templates t ON r.template_id = t.id
    ORDER BY r.id
  `).all() as any[],
  getActive: () => db.prepare(`
    SELECT r.*, p.name as project_name, a.username, ai.name as ai_name
    FROM schedule_rules r
    JOIN projects p ON r.project_id = p.id
    JOIN accounts a ON r.account_id = a.id
    JOIN ai_configs ai ON r.ai_config_id = ai.id
    WHERE r.is_active = 1 AND p.is_active = 1 AND a.is_active = 1 AND ai.is_active = 1
  `).all() as any[],
  getByProject: (projectId: any) => db.prepare('SELECT * FROM schedule_rules WHERE project_id = ?').all(projectId) as any[],
  create: (data: any) => db.prepare(`INSERT INTO schedule_rules (project_id, account_id, ai_config_id, template_id, preview_time, post_times, active_days, timing_variance_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(data.project_id, data.account_id, data.ai_config_id, data.template_id, data.preview_time, data.post_times, data.active_days, data.timing_variance_min),
  update: (data: any) => db.prepare(`UPDATE schedule_rules SET preview_time=?, post_times=?, active_days=?, timing_variance_min=?, is_active=? WHERE id=?`).run(data.preview_time, data.post_times, data.active_days, data.timing_variance_min, data.is_active, data.id),
  delete: (id: any) => db.prepare('DELETE FROM schedule_rules WHERE id = ?').run(id),
};

// ─── Scheduled Posts ──────────────────────────────────────────────────────────
// scheduled_time은 toISOString() UTC 포맷("2025-01-15T09:00:00.000Z")으로 저장됨
// date('now', 'localtime')과 직접 비교하면 포맷 불일치로 항상 실패하므로
// date(scheduled_time, 'localtime')으로 UTC→로컬 변환 후 비교
const todayPostsSql = `
  SELECT sp.*, a.username, p.name as project_name
  FROM scheduled_posts sp
  JOIN accounts a ON sp.account_id = a.id
  JOIN projects p ON sp.project_id = p.id
  WHERE date(sp.scheduled_time, 'localtime') = date('now', 'localtime')
     OR (sp.source_type = 'benchmarking' AND sp.status IN ('generated', 'approved', 'failed', 'posting'))
  ORDER BY sp.scheduled_time
`;

const pendingPreviewSql = `
  SELECT sp.*, a.username, p.name as project_name
  FROM scheduled_posts sp
  JOIN accounts a ON sp.account_id = a.id
  JOIN projects p ON sp.project_id = p.id
  WHERE sp.status = 'approved'
  OR (
    sp.status IN ('generated', 'failed')
    AND (
      sp.source_type = 'benchmarking'
      OR date(sp.scheduled_time, 'localtime') >= date('now', 'localtime')
    )
  )
  ORDER BY sp.scheduled_time ASC, sp.created_at DESC
`;

export const postQueries = {
  getToday: () => db.prepare(todayPostsSql).all() as any[],
  getPendingPreview: () => db.prepare(pendingPreviewSql).all() as any[],
  // 오늘 게시완료 수: posted_at 기준 오늘, status가 posted 또는 scheduled인 것
  getTodayPosted: () => (db.prepare(`
    SELECT COUNT(*) as cnt FROM scheduled_posts
    WHERE status IN ('posted', 'scheduled')
    AND date(posted_at, 'localtime') = date('now', 'localtime')
  `).get() as any).cnt as number,
  // 전체 포스팅 완료 수: posted + scheduled 전체 (KPI용)
  getTotalPosted: () => (db.prepare(`
    SELECT COUNT(*) as cnt FROM scheduled_posts
    WHERE status IN ('posted', 'scheduled')
  `).get() as any).cnt as number,
  // 자동발행용: scheduled_time이 지난 approved 포스트이며 publish_mode='auto'인 것만
  getApproved: () => db.prepare(`
    SELECT sp.*, a.username, p.name as project_name,
           ai.profile_dir as ai_profile_dir, ai.ai_type, ai.url as ai_url,
           a.profile_dir as account_profile_dir
    FROM scheduled_posts sp
    JOIN accounts a ON sp.account_id = a.id
    LEFT JOIN ai_configs ai ON sp.ai_config_id = ai.id
    JOIN projects p ON sp.project_id = p.id
    WHERE sp.status = 'approved'
    AND datetime(sp.scheduled_time) <= datetime('now')
    AND sp.publish_mode = 'auto'
    ORDER BY sp.scheduled_time
  `).all() as any[],
  // 네이티브 예약용: publish_mode='native'인 approved 포스트만 (계정별 일괄 처리)
  getApprovedForScheduling: () => db.prepare(`
    SELECT sp.*, a.username, p.name as project_name,
           ai.profile_dir as ai_profile_dir, ai.ai_type, ai.url as ai_url,
           a.profile_dir as account_profile_dir
    FROM scheduled_posts sp
    JOIN accounts a ON sp.account_id = a.id
    LEFT JOIN ai_configs ai ON sp.ai_config_id = ai.id
    JOIN projects p ON sp.project_id = p.id
    WHERE sp.status = 'approved'
    AND sp.publish_mode = 'native'
    ORDER BY sp.account_id, sp.scheduled_time
  `).all() as any[],
  markScheduled: (id: any) => db.prepare(`UPDATE scheduled_posts SET status='scheduled', posted_at=datetime('now') WHERE id=?`).run(id),
  getRecent: (filters?: { account_id?: number; project_id?: number; status?: string }) => {
    const conditions: string[] = [];
    const params: any[] = [];
    if (filters?.account_id) { conditions.push('sp.account_id = ?'); params.push(filters.account_id); }
    if (filters?.project_id) { conditions.push('sp.project_id = ?'); params.push(filters.project_id); }
    // 기본값: posted + scheduled만 표시. 필터가 있으면 해당 상태만.
    if (filters?.status) {
      conditions.push('sp.status = ?'); params.push(filters.status);
    } else {
      conditions.push("sp.status IN ('posted', 'scheduled')");
    }
    const where = 'WHERE ' + conditions.join(' AND ');
    return db.prepare(`
      SELECT sp.*, a.username, p.name as project_name
      FROM scheduled_posts sp
      JOIN accounts a ON sp.account_id = a.id
      JOIN projects p ON sp.project_id = p.id
      ${where}
      ORDER BY COALESCE(sp.posted_at, sp.scheduled_time) DESC LIMIT 300
    `).all(...params) as any[];
  },
  getDailyCounts: () => db.prepare(`
    SELECT date(COALESCE(sp.posted_at, sp.scheduled_time), 'localtime') as day,
           COUNT(*) as total,
           SUM(CASE WHEN sp.status='posted' THEN 1 ELSE 0 END) as posted,
           SUM(CASE WHEN sp.status='scheduled' THEN 1 ELSE 0 END) as scheduled
    FROM scheduled_posts sp
    WHERE sp.status IN ('posted', 'scheduled')
    AND COALESCE(sp.posted_at, sp.scheduled_time) >= datetime('now', '-60 days')
    GROUP BY day
    ORDER BY day DESC
  `).all() as any[],
  setPublishMode: (ids: number[], mode: string) => {
    const stmt = db.prepare(`UPDATE scheduled_posts SET publish_mode=? WHERE id=?`);
    for (const id of ids) stmt.run(mode, id);
  },
  getById: (id: any) => db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id) as any,
  create: (data: any) => db.prepare(`INSERT INTO scheduled_posts (rule_id, project_id, account_id, ai_config_id, template_id, generated_content, comment_content, scheduled_time, status, publish_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'native')`).run(data.rule_id, data.project_id, data.account_id, data.ai_config_id, data.template_id, data.generated_content, data.comment_content, data.scheduled_time, data.status),
  updateStatus: (data: any) => db.prepare('UPDATE scheduled_posts SET status=? WHERE id=?').run(data.status, data.id),
  updateContent: (data: any) => db.prepare('UPDATE scheduled_posts SET generated_content=?, comment_content=?, status=? WHERE id=?').run(data.generated_content, data.comment_content, data.status, data.id),
  approve: (id: any) => db.prepare(`UPDATE scheduled_posts SET status='approved', approved_at=datetime('now') WHERE id=?`).run(id),
  skip: (id: any) => db.prepare(`UPDATE scheduled_posts SET status='skipped' WHERE id=?`).run(id),
  markPosted: (data: any) => db.prepare(`UPDATE scheduled_posts SET status='posted', posted_at=datetime('now'), post_url=? WHERE id=?`).run(data.post_url, data.id),
  markFailed: (data: any) => db.prepare(`UPDATE scheduled_posts SET status='failed', error_message=? WHERE id=?`).run(data.error_message, data.id),
  resetForRegeneration: (id: any) => db.prepare(`UPDATE scheduled_posts SET status='pending_generation', error_message='' WHERE id=?`).run(id),
  returnToPreview: (id: any) => db.prepare(`UPDATE scheduled_posts SET status='generated', approved_at=NULL WHERE id=?`).run(id),
  createBenchmarking: (data: any) => db.prepare(`
    INSERT INTO scheduled_posts (rule_id, project_id, account_id, ai_config_id, template_id, generated_content, comment_content, original_content, original_comment, comment_links, scheduled_time, status, source_type, source_url, media_paths, publish_mode)
    VALUES (NULL, ?, ?, 0, 0, ?, ?, ?, ?, ?, datetime('now', '+2 hours'), 'generated', 'benchmarking', ?, ?, 'native')
  `).run(data.project_id, data.account_id, data.generated_content, data.comment_content || '', data.original_content || '', data.original_comment || '', data.comment_links || '[]', data.source_url, data.media_paths),
  updateMediaPaths: (id: any, mediaPaths: string) => db.prepare(
    'UPDATE scheduled_posts SET media_paths=? WHERE id=?'
  ).run(mediaPaths, id),
  updateScheduledTime: (id: any, scheduledTime: string) => db.prepare(
    'UPDATE scheduled_posts SET scheduled_time=? WHERE id=?'
  ).run(scheduledTime, id),
  delete: (id: any) => db.prepare('DELETE FROM scheduled_posts WHERE id=?').run(id),
  getBenchmarkingByProject: (projectId: any) => db.prepare(`
    SELECT sp.*, a.username
    FROM scheduled_posts sp
    JOIN accounts a ON sp.account_id = a.id
    WHERE sp.project_id = ? AND sp.source_type = 'benchmarking'
    ORDER BY sp.created_at DESC
    LIMIT 100
  `).all(projectId) as any[],
  checkExisting: (ruleId: any, scheduledTime: string) => db.prepare(`
    SELECT id FROM scheduled_posts
    WHERE rule_id = ? AND date(scheduled_time, 'localtime') = date('now', 'localtime')
    AND abs(strftime('%s', scheduled_time) - strftime('%s', ?)) < 1800
  `).get(ruleId, scheduledTime) as any,
};

export const logQueries = {
  add: (postId: number, level: string, message: string) => db.prepare('INSERT INTO post_logs (post_id, level, message) VALUES (?, ?, ?)').run(postId, level, message),
  getByPost: (postId: any) => db.prepare('SELECT * FROM post_logs WHERE post_id = ? ORDER BY created_at').all(postId) as any[],
};

export function addLog(postId: number, level: 'info' | 'warn' | 'error', message: string) {
  logQueries.add(postId, level, message);
  console.log(`[Post ${postId}][${level.toUpperCase()}] ${message}`);
}

// ─── Project Benchmarking Config ─────────────────────────────────────────────
export const projectBenchmarkingQueries = {
  getByProject: (projectId: any) => db.prepare(
    'SELECT * FROM project_benchmarking WHERE project_id = ?'
  ).get(projectId) as any,
  getAllEnabled: () => db.prepare(`
    SELECT pb.*, p.name as project_name
    FROM project_benchmarking pb
    JOIN projects p ON pb.project_id = p.id
    WHERE pb.is_enabled = 1 AND p.is_active = 1
  `).all() as any[],
  getOverview: () => db.prepare(`
    SELECT
      pb.*,
      p.name as project_name,
      a.username as posting_account,
      COUNT(CASE WHEN sp.source_type='benchmarking' AND sp.status='generated'  THEN 1 END) as in_preview,
      COUNT(CASE WHEN sp.source_type='benchmarking' AND sp.status='approved'   THEN 1 END) as approved,
      COUNT(CASE WHEN sp.source_type='benchmarking' AND sp.status IN ('posted','scheduled')
                  AND date(sp.posted_at,'localtime')=date('now','localtime')   THEN 1 END) as posted_today,
      COUNT(CASE WHEN sp.source_type='benchmarking' AND sp.status IN ('posted','scheduled') THEN 1 END) as posted_total,
      COUNT(CASE WHEN sp.source_type='benchmarking' THEN 1 END) as total_scraped
    FROM project_benchmarking pb
    JOIN projects p ON pb.project_id = p.id
    LEFT JOIN accounts a ON pb.posting_account_id = a.id
    LEFT JOIN scheduled_posts sp ON sp.project_id = pb.project_id
    WHERE p.is_active = 1
    GROUP BY pb.project_id
    ORDER BY p.name
  `).all() as any[],
  upsert: (data: any) => db.prepare(`
    INSERT INTO project_benchmarking (project_id, is_enabled, interval_hours, posts_per_run, posting_account_id, ai_config_id, rewrite_prompt, targets, last_checked_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET
      is_enabled=excluded.is_enabled, interval_hours=excluded.interval_hours,
      posts_per_run=excluded.posts_per_run,
      posting_account_id=excluded.posting_account_id, ai_config_id=excluded.ai_config_id,
      rewrite_prompt=excluded.rewrite_prompt, targets=excluded.targets,
      last_checked_at=excluded.last_checked_at, updated_at=datetime('now')
  `).run(data.project_id, data.is_enabled, data.interval_hours, data.posts_per_run ?? 1, data.posting_account_id, data.ai_config_id, data.rewrite_prompt, data.targets, data.last_checked_at ?? ''),
  updateLastChecked: (projectId: any) => db.prepare(
    `UPDATE project_benchmarking SET last_checked_at=datetime('now') WHERE project_id=?`
  ).run(projectId),
};

// ─── Benchmarking Jobs ────────────────────────────────────────────────────────
export const benchmarkingJobQueries = {
  getAll: () => db.prepare(
    'SELECT * FROM benchmarking_jobs ORDER BY created_at DESC LIMIT 100'
  ).all() as any[],
  getById: (id: any) => db.prepare(
    'SELECT * FROM benchmarking_jobs WHERE id = ?'
  ).get(id) as any,
  create: (data: any) => db.prepare(
    'INSERT INTO benchmarking_jobs (source_account, source_post_url, original_content, rewritten_content, media_paths, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(data.sourceAccount, data.sourcePostUrl, data.originalContent, data.rewrittenContent, data.mediaPaths, data.status),
  updateStatus: (id: any, status: string) => db.prepare(
    'UPDATE benchmarking_jobs SET status = ? WHERE id = ?'
  ).run(status, id),
  updateRewritten: (id: any, content: string) => db.prepare(
    'UPDATE benchmarking_jobs SET rewritten_content = ? WHERE id = ?'
  ).run(content, id),
  updateMediaPaths: (id: any, paths: string) => db.prepare(
    'UPDATE benchmarking_jobs SET media_paths = ? WHERE id = ?'
  ).run(paths, id),
  markDone: (id: any, postedUrl: string) => db.prepare(
    `UPDATE benchmarking_jobs SET status = 'done', posted_url = ?, posted_at = datetime('now') WHERE id = ?`
  ).run(postedUrl, id),
  markFailed: (id: any, errorMessage: string) => db.prepare(
    `UPDATE benchmarking_jobs SET status = 'failed', error_message = ? WHERE id = ?`
  ).run(errorMessage, id),
};

// ─── Scrapes ──────────────────────────────────────────────────────────────────
export const scrapesQueries = {
  create: (data: {
    project_id: number; account_id: number; source_url: string;
    source_username: string; text_content: string; first_comment: string;
    comment_links?: string; media_urls: string; media_local_paths: string; linked_post_id?: number;
  }) => db.prepare(`
    INSERT INTO scrapes (project_id, account_id, source_url, source_username, text_content, first_comment, comment_links, media_urls, media_local_paths, linked_post_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(data.project_id, data.account_id, data.source_url, data.source_username,
         data.text_content, data.first_comment, data.comment_links ?? '[]',
         data.media_urls, data.media_local_paths, data.linked_post_id ?? null),

  getAll: (filters?: { project_id?: number; account_id?: number; limit?: number }) => {
    const conds: string[] = [];
    const params: any[] = [];
    if (filters?.project_id) { conds.push('s.project_id = ?'); params.push(filters.project_id); }
    if (filters?.account_id) { conds.push('s.account_id = ?'); params.push(filters.account_id); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const limit = filters?.limit ?? 500;
    return db.prepare(`
      SELECT s.*, p.name as project_name, a.username
      FROM scrapes s
      LEFT JOIN projects p ON s.project_id = p.id
      LEFT JOIN accounts a ON s.account_id = a.id
      ${where}
      ORDER BY s.scraped_at DESC
      LIMIT ${limit}
    `).all(...params) as any[];
  },

  getById: (id: any) => db.prepare('SELECT * FROM scrapes WHERE id = ?').get(id) as any,

  linkPost: (scrapeId: any, postId: number) => db.prepare(
    'UPDATE scrapes SET linked_post_id = ? WHERE id = ?'
  ).run(postId, scrapeId),

  updateMediaPaths: (scrapeId: any, mediaLocalPaths: string) => db.prepare(
    'UPDATE scrapes SET media_local_paths = ? WHERE id = ?'
  ).run(mediaLocalPaths, scrapeId),

  delete: (id: any) => db.prepare('DELETE FROM scrapes WHERE id = ?').run(id),

  alreadyScraped: (sourceUrl: string) => !!db.prepare(
    'SELECT id FROM scrapes WHERE source_url = ? LIMIT 1'
  ).get(sourceUrl),
};

// ─── App Settings ─────────────────────────────────────────────────────────────
export const appSettingsQueries = {
  get: (key: string): string => {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any;
    return row ? row.value : '';
  },
  set: (key: string, value: string) => db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value),
  getAll: () => db.prepare('SELECT key, value FROM app_settings').all() as any[],
};
