// Electron main process
//
// 역할:
//   1) 사용자 PC에서 Express 백엔드를 백그라운드로 기동
//   2) 시스템 트레이 아이콘으로 상태 표시(실행 중/정지) + 제어
//   3) 첫 실행 시 Playwright chromium 자동 설치 (미설치 시)
//   4) 창 없이 돌아가지만, 트레이에서 "상태창 보기"로 로그/컨트롤 UI 표시 가능
//
// 진입점: package.json의 "main"이 이 파일을 가리킴

const { app, Tray, Menu, BrowserWindow, nativeImage, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ── 싱글 인스턴스 락 (중복 실행 방지) ─────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

// 웹 프론트 — Vercel 배포 영구 URL (사용자 PC의 localhost:4000 백엔드와 통신)
const WEB_APP_URL = process.env.THREADS_WEB_URL || 'https://threads-autoposter.vercel.app';
const LOCAL_URL = 'http://localhost:4000';
const APP_ROOT = app.getAppPath();
const USER_DATA = app.getPath('userData');
const PW_MARKER = path.join(USER_DATA, '.playwright-installed');

// 패키징된 앱에서만 browsers 경로를 userData로 이동 (dev에서는 전역 설치된 playwright 재사용)
if (app.isPackaged) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(USER_DATA, 'playwright-browsers');
}

let tray = null;
let statusWin = null;
let serverProc = null;
let serverStatus = 'starting'; // starting | running | error | stopped

// ── 사용자 설정(파일) ──────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(USER_DATA, 'app-settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}
function writeSettings(s) {
  try { fs.mkdirSync(USER_DATA, { recursive: true }); fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)); } catch (_) {}
}

// ── 부팅 시 자동 실행 (패키징된 앱에서만 의미 있음) ────────────────────────
function setAutoLaunch(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    openAsHidden: true, // 트레이만 켜고 창 없이 시작
    path: process.execPath,
    args: [],
  });
  const s = readSettings(); s.autoLaunch = !!enabled; writeSettings(s);
}
function getAutoLaunchEnabled() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings().openAtLogin;
}
function applyFirstLaunchDefaults() {
  const s = readSettings();
  if (s.firstLaunchDone) return;
  setAutoLaunch(true);   // 기본값: 자동 실행 ON
  s.firstLaunchDone = true;
  s.autoLaunch = true;
  writeSettings(s);
}

// ── 트레이 아이콘 ──────────────────────────────────────────────────────────
function loadTrayImage() {
  const iconPath = path.join(APP_ROOT, 'electron', 'tray-icon.png');
  if (fs.existsSync(iconPath)) {
    try {
      const img = nativeImage.createFromPath(iconPath);
      return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 });
    } catch (_) {}
  }
  return nativeImage.createEmpty();
}

function statusLabel() {
  return {
    starting: '상태: 기동 중...',
    running:  '상태: 실행 중 ✅',
    error:    '상태: 오류 ❌',
    stopped:  '상태: 정지 ⏸',
  }[serverStatus] || '상태: 알 수 없음';
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Threads AutoPoster', enabled: false },
    { label: statusLabel(), enabled: false },
    { type: 'separator' },
    { label: '웹 앱 열기 (권장)', click: () => shell.openExternal(WEB_APP_URL) },
    { label: '로컬 UI 열기', click: () => shell.openExternal(LOCAL_URL) },
    { type: 'separator' },
    { label: '상태/로그 창 열기', click: () => openStatusWindow() },
    { label: '백엔드 재시작', click: () => restartBackend() },
    {
      label: 'Windows 시작 시 자동 실행',
      type: 'checkbox',
      checked: getAutoLaunchEnabled(),
      enabled: app.isPackaged,
      click: (item) => { setAutoLaunch(item.checked); updateTrayMenu(); },
    },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Threads AutoPoster — ${statusLabel().replace('상태: ', '')}`);
}

function createTray() {
  tray = new Tray(loadTrayImage());
  tray.on('click', () => openStatusWindow());
  updateTrayMenu();
}

// ── 상태/로그 창 (옵션, 트레이에서 열기) ────────────────────────────────────
let statusLog = [];
function appendLog(line) {
  const ts = new Date().toLocaleTimeString('ko-KR');
  const msg = `[${ts}] ${line}`;
  statusLog.push(msg);
  if (statusLog.length > 500) statusLog.shift();
  console.log(msg);
  if (statusWin && !statusWin.isDestroyed()) {
    statusWin.webContents.send('log', line);
  }
}

function openStatusWindow() {
  if (statusWin && !statusWin.isDestroyed()) {
    statusWin.show(); statusWin.focus();
    return;
  }
  statusWin = new BrowserWindow({
    width: 720, height: 480,
    title: 'Threads AutoPoster — 상태',
    icon: loadTrayImage(),
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    autoHideMenuBar: true,
  });
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>상태</title>
  <style>
    body{margin:0;background:#0f0f0f;color:#e8e8e8;font:13px -apple-system,'Segoe UI',sans-serif}
    header{padding:12px 16px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between}
    h1{font-size:14px;margin:0;color:#9d5cf5}
    .badge{padding:3px 10px;border-radius:99px;font-size:12px}
    .badge.running{background:#1e3d1e;color:#7cd17c;border:1px solid #2d5a2d}
    .badge.starting{background:#3a2500;color:#fde68a;border:1px solid #a16207}
    .badge.error{background:#3b1d1d;color:#ff8a80;border:1px solid #7a2626}
    .badge.stopped{background:#2a2a2a;color:#aaa;border:1px solid #444}
    main{padding:8px 16px;overflow:auto;height:calc(100vh - 110px)}
    pre{margin:0;font:12px Consolas,monospace;white-space:pre-wrap;word-break:break-all;color:#bbb}
    footer{padding:10px 16px;border-top:1px solid #333;display:flex;gap:8px}
    button{background:#7c3aed;color:white;border:none;padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer}
    button.sec{background:#2a2a2a;color:#e8e8e8;border:1px solid #444}
    a{color:#9d5cf5}
  </style></head><body>
    <header>
      <h1>🧵 Threads AutoPoster 백엔드</h1>
      <span id="st" class="badge starting">기동 중...</span>
    </header>
    <main><pre id="log"></pre></main>
    <footer>
      <button onclick="location.href='${LOCAL_URL}'" style="display:none">로컬 UI</button>
      <button class="sec" onclick="window.open('${LOCAL_URL}')">로컬 UI 열기</button>
      <button class="sec" onclick="window.open('${WEB_APP_URL}')">웹 앱 열기</button>
    </footer>
    <script>
      const logEl = document.getElementById('log');
      const stEl = document.getElementById('st');
      function setStatus(s){ stEl.className='badge '+s; stEl.textContent={starting:'기동 중...',running:'실행 중',error:'오류',stopped:'정지'}[s]||s; }
      function appendLog(l){ logEl.textContent += (logEl.textContent?'\\n':'') + l; logEl.parentElement.scrollTop=logEl.parentElement.scrollHeight; }
      // 초기 로그 로드
      fetch('data:application/json,' + encodeURIComponent(JSON.stringify(${JSON.stringify(statusLog)})))
        .then(r=>r.json()).then(arr=>arr.forEach(appendLog));
      setStatus(${JSON.stringify(serverStatus)});
    </script>
  </body></html>`;
  statusWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  statusWin.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); statusWin.hide(); }
  });
}

// ── Playwright chromium 첫 실행 설치 (패키징된 앱에서만) ────────────────────
async function ensurePlaywrightBrowsers() {
  if (!app.isPackaged) {
    appendLog('[playwright] dev 모드 — 전역 설치된 playwright 사용 (설치 스킵)');
    return true;
  }
  if (fs.existsSync(PW_MARKER)) return true;
  appendLog('[playwright] chromium 설치 시작 (최초 1회, 최대 수 분 소요)...');

  return new Promise((resolve) => {
    const cliPath = path.join(APP_ROOT, 'node_modules', 'playwright-core', 'cli.js');
    // playwright-core가 없으면 playwright의 cli 사용
    const fallback = path.join(APP_ROOT, 'node_modules', 'playwright', 'cli.js');
    const useCli = fs.existsSync(cliPath) ? cliPath : (fs.existsSync(fallback) ? fallback : null);
    if (!useCli) {
      appendLog('[playwright] cli.js 없음 — 설치 건너뜀 (수동 설치 필요)');
      return resolve(false);
    }
    const child = spawn(process.execPath, [useCli, 'install', 'chromium'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: APP_ROOT,
    });
    child.stdout?.on('data', (d) => appendLog('[playwright] ' + d.toString().trim()));
    child.stderr?.on('data', (d) => appendLog('[playwright] ' + d.toString().trim()));
    child.on('exit', (code) => {
      if (code === 0) {
        try { fs.mkdirSync(USER_DATA, { recursive: true }); fs.writeFileSync(PW_MARKER, new Date().toISOString()); } catch (_) {}
        appendLog('[playwright] 설치 완료');
        resolve(true);
      } else {
        appendLog(`[playwright] 설치 실패 (exit ${code}) — 재시도: 트레이 → 백엔드 재시작`);
        resolve(false);
      }
    });
  });
}

// ── Express 백엔드 기동 ────────────────────────────────────────────────────
function startBackend() {
  const entry = path.join(APP_ROOT, 'dist', 'index.js');
  appendLog(`[server] spawn: ${entry}`);
  if (!fs.existsSync(entry)) {
    appendLog(`[error] dist/index.js 없음 — 'npm run build' 필요`);
    serverStatus = 'error';
    updateTrayMenu();
    return;
  }
  serverStatus = 'starting';
  updateTrayMenu();

  appendLog(`[server] execPath=${process.execPath}`);
  serverProc = spawn(process.execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
    cwd: APP_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.on('error', (e) => appendLog(`[server-spawn-error] ${e.message}`));
  serverProc.stdout.on('data', (d) => {
    const s = d.toString();
    s.split('\n').filter(Boolean).forEach(appendLog);
    if (s.includes('실행 중') || s.includes('listening')) {
      serverStatus = 'running';
      updateTrayMenu();
    }
  });
  serverProc.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(l => appendLog('[err] ' + l)));
  serverProc.on('exit', (code) => {
    appendLog(`[server] 종료 (code=${code})`);
    serverStatus = code === 0 ? 'stopped' : 'error';
    serverProc = null;
    updateTrayMenu();
  });
}

function restartBackend() {
  appendLog('[server] 재시작 요청');
  if (serverProc) {
    serverProc.once('exit', () => startBackend());
    serverProc.kill();
  } else {
    startBackend();
  }
}

// ── 앱 생명주기 ────────────────────────────────────────────────────────────
app.on('second-instance', () => openStatusWindow());

app.whenReady().then(async () => {
  applyFirstLaunchDefaults();
  createTray();
  appendLog('Electron 준비 완료');
  appendLog(`[autolaunch] ${app.isPackaged ? (getAutoLaunchEnabled() ? '활성' : '비활성') : 'dev 모드(스킵)'}`);
  await ensurePlaywrightBrowsers();
  startBackend();

  if (Notification.isSupported()) {
    new Notification({
      title: 'Threads AutoPoster 실행 중',
      body: '시스템 트레이 아이콘에서 상태를 확인하세요.',
    }).show();
  }
});

app.on('window-all-closed', (e) => {
  // 창을 다 닫아도 앱은 트레이에 남아있음
  e.preventDefault?.();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProc) {
    try { serverProc.kill(); } catch (_) {}
  }
});
