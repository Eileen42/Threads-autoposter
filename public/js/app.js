// ─── State ────────────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let activeTasksTimer = null;
let currentProjectId = null;
let editingId = null;
let cachedProjects = [];    // loadProjects()에서 채워짐 (editProject에서 재사용)
let modalOpenTime = 0;      // 모달 열린 시각 (overlay 즉시닫힘 방지)
let editingScheduleId = null;    // 수정 중인 스케줄 rule ID
let editingScheduleProjId = null; // 수정 중인 스케줄 project ID
let cachedScheduleData = {};     // { projects, allAccounts, allAI, allTemplates }
let postTimes = ['18:00'];
let hashtags = [];
let previewProjectFilter = 'all';
let previewTypeFilter = 'all';
let previewAllPosts = [];
let qaBmConfig = null;      // 빠른 추가 모달에서 로드한 벤치마킹 설정

// ─── Navigation ───────────────────────────────────────────────────────────────
function navigate(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  document.getElementById(`page-${page}`).classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    if (n.getAttribute('onclick')?.includes(`'${page}'`)) n.classList.add('active');
  });

  currentPage = page;
  localStorage.setItem('currentPage', page);

  // Stop active tasks polling when leaving dashboard
  if (page !== 'dashboard' && activeTasksTimer) {
    clearInterval(activeTasksTimer);
    activeTasksTimer = null;
  }

  if (page === 'dashboard') loadDashboard();
  else if (page === 'preview') loadPreview();
  else if (page === 'pending') loadPending();
  else if (page === 'history') loadHistory();
  else if (page === 'projects') loadProjects();
  else if (page === 'schedules') loadSchedules();
  else if (page === 'scrapes') loadScrapes();
}

// ─── API helper ───────────────────────────────────────────────────────────────
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 서버가 JSON이 아닌 응답(HTML 에러 등) 반환 시
    throw new Error(`서버 오류 (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast-item ${type}`;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─── Status badges ────────────────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    pending_generation: ['생성 전', 'gray'],
    generated: ['승인 대기', 'yellow'],
    approved: ['승인됨', 'blue'],
    posting: ['예약 등록 중', 'purple'],
    scheduled: ['Threads 예약됨 ✅', 'green'],
    posted: ['게시 완료', 'green'],
    failed: ['실패', 'red'],
    skipped: ['건너뜀', 'gray'],
  };
  const [label, color] = map[status] || [status, 'gray'];
  return `<span class="badge badge-${color}">${label}</span>`;
}

function formatTime(dt) {
  if (!dt) return '-';
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC, no timezone marker)
  // Add 'Z' to parse as UTC so local timezone is applied correctly
  const iso = dt.includes('T') ? dt : dt.replace(' ', 'T') + 'Z';
  return new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatScheduledTime(dt) {
  if (!dt) return '';
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (UTC), ISO has T
  const iso = dt.includes('T') ? dt : dt.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return dt;
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return '오늘 ' + timeStr;
  return d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) + ' ' + timeStr;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
  document.getElementById('today-date').textContent = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

  try {
    const [status, projects] = await Promise.all([
      api('GET', '/api/scheduler/status'),
      api('GET', '/api/projects'),
    ]);

    // 스탯 카드
    document.getElementById('stat-projects').textContent = projects.length;
    document.getElementById('stat-pending').textContent = status.pendingApproval;
    document.getElementById('stat-total-posted').textContent = status.totalPosted;
    document.getElementById('stat-posted').textContent = status.todayPosted;

    // 사이드바 뱃지
    const projBadge = document.getElementById('projects-badge');
    if (projBadge) {
      projBadge.style.display = projects.length > 0 ? 'inline' : 'none';
      projBadge.textContent = projects.length;
    }
    const previewBadge = document.getElementById('preview-badge');
    if (previewBadge) {
      previewBadge.style.display = status.pendingApproval > 0 ? 'inline' : 'none';
      previewBadge.textContent = status.pendingApproval;
    }
    const pendingBadge = document.getElementById('pending-badge');
    if (pendingBadge) {
      pendingBadge.style.display = status.pendingSchedule > 0 ? 'inline' : 'none';
      pendingBadge.textContent = status.pendingSchedule;
    }

    // 승인 대기 알람 배너
    const alertEl = document.getElementById('dashboard-pending-alert');
    if (alertEl) {
      if (status.pendingApproval > 0) {
        alertEl.style.display = 'flex';
        alertEl.innerHTML = `
          <span style="font-size:16px">🔔</span>
          <span><strong>${status.pendingApproval}개</strong>의 포스트가 승인 대기 중입니다.</span>
          <div style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-xs btn-green" onclick="navigate('preview')">미리보기로 이동</button>
            <button class="btn btn-xs btn-secondary" onclick="approveAllGenerated()">전체 승인</button>
          </div>`;
      } else {
        alertEl.style.display = 'none';
      }
    }
  } catch (e) {
    toast('대시보드 로드 실패: ' + e.message, 'error');
  }

  loadBenchmarkingOverview();

  // Start active tasks polling
  loadActiveTasks();
  if (!activeTasksTimer) {
    activeTasksTimer = setInterval(loadActiveTasks, 5000);
  }
}

async function loadActiveTasks() {
  try {
    const { tasks } = await api('GET', '/api/scheduler/active-tasks');
    const panel = document.getElementById('active-tasks-panel');
    const list = document.getElementById('active-tasks-list');
    if (!panel || !list) return;

    if (tasks.length === 0) {
      panel.style.display = 'none';
      // Stop polling once nothing is running
      if (activeTasksTimer) {
        clearInterval(activeTasksTimer);
        activeTasksTimer = null;
      }
      return;
    }

    panel.style.display = 'block';
    const hasBenchmarking = tasks.some(t => t.id === 'benchmarking');
    const stopBtn = document.getElementById('bm-stop-btn');
    if (stopBtn) stopBtn.style.display = hasBenchmarking ? 'inline-flex' : 'none';
    list.innerHTML = tasks.map(t => {
      const elapsed = Math.floor((Date.now() - t.since) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const elapsedStr = min > 0 ? `${min}분 ${sec}초` : `${sec}초`;
      const icons = { generating: '🤖', posting: '📤', benchmarking: '🔍' };
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #2a1a3e">
          <span style="font-size:15px">${icons[t.id] || '⚙️'}</span>
          <span style="font-size:13px;font-weight:500">${t.label}</span>
          <span style="font-size:11px;color:var(--text2);margin-left:auto">⏱ ${elapsedStr}</span>
        </div>`;
    }).join('');
    // Restart polling if it was stopped
    if (!activeTasksTimer) {
      activeTasksTimer = setInterval(loadActiveTasks, 5000);
    }
  } catch { /* silent */ }
}

function renderTodayPosts(posts) {
  const el = document.getElementById('today-posts-list');
  if (posts.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><p>오늘 예정된 포스트가 없습니다.<br>스케줄을 설정하거나 직접 생성하세요.</p></div>';
    return;
  }

  const generatedPosts = posts.filter(p => p.status === 'generated');
  const banner = generatedPosts.length > 0 ? `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;margin-bottom:12px;background:#1e1040;border:1px solid var(--accent);border-radius:8px;font-size:13px">
      <span style="font-size:16px">⚠️</span>
      <span style="color:var(--text)"><strong>${generatedPosts.length}개</strong> 포스트가 승인 대기 중입니다. 승인 후 "Threads 예약하기"를 실행하세요.</span>
      <button class="btn btn-sm btn-green" style="margin-left:auto;white-space:nowrap" onclick="approveAllGenerated()">전체 승인</button>
    </div>` : '';

  el.innerHTML = banner + `<div class="table-wrap"><table>
    <thead><tr><th>시간</th><th>계정</th><th>프로젝트</th><th>상태</th><th>내용 미리보기</th><th>액션</th></tr></thead>
    <tbody>${posts.map(p => `
      <tr${p.status === 'generated' ? ' style="background:rgba(109,40,217,0.08)"' : ''}>
        <td style="white-space:nowrap">${formatTime(p.scheduled_time)}</td>
        <td>@${p.username}</td>
        <td>${p.project_name}</td>
        <td>${statusBadge(p.status)}</td>
        <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.generated_content ? p.generated_content.substring(0,80)+'...' : '(생성 전)'}</td>
        <td>
          <div class="flex gap-8">
            ${p.status === 'pending_generation' || p.status === 'failed' ? `<button class="btn btn-xs btn-secondary" onclick="regenerate(${p.id})">재생성</button>` : ''}
            ${p.status === 'failed' && p.generated_content ? `<button class="btn btn-xs btn-primary" onclick="postNow(${p.id})">▶ 다시 포스팅</button>` : ''}
            ${p.status === 'generated' ? `<button class="btn btn-sm btn-green" onclick="approvePost(${p.id})" style="font-weight:600">✓ 승인</button>` : ''}
            ${p.status === 'approved' ? `<button class="btn btn-xs btn-primary" onclick="postNow(${p.id})">지금 포스팅</button><button class="btn btn-xs btn-secondary" onclick="returnPost(${p.id})">반려</button>` : ''}
            <button class="btn btn-xs btn-secondary" onclick="viewPost(${p.id})">보기</button>
          </div>
        </td>
      </tr>
    `).join('')}</tbody>
  </table></div>`;
}

async function triggerTodayGeneration() {
  toast('콘텐츠 생성 시작... 브라우저가 열릴 수 있습니다.', 'info');
  // 현재는 각 포스트 ID를 모르므로 pending 상태 포스트들 가져와서 생성
  const posts = await api('GET', '/api/posts/today');
  const pending = posts.filter(p => p.status === 'pending_generation');
  if (pending.length === 0) {
    toast('생성할 포스트가 없습니다. 먼저 스케줄을 설정하세요.', 'info');
    return;
  }
  for (const p of pending) {
    await regenerate(p.id);
  }
}

// ─── Preview ──────────────────────────────────────────────────────────────────
function toggleOriginal(postId) {
  const el = document.getElementById(`original-${postId}`);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function extractLinks(text) {
  if (!text) return [];
  const urlRegex = /https?:\/\/[^\s<>"'\)]+/g;
  return [...new Set(text.match(urlRegex) || [])];
}

function setPreviewFilter(type) {
  previewTypeFilter = type;
  ['all', 'scheduled', 'benchmarking'].forEach(t => {
    const btn = document.getElementById(`filter-${t}`);
    if (btn) btn.className = `btn btn-sm ${t === type ? 'btn-primary' : 'btn-secondary'}`;
  });
  renderPreview();
}

function setPreviewProjectFilter(projectId) {
  previewProjectFilter = projectId;
  // Update pill styles
  document.querySelectorAll('#preview-project-filters button').forEach(btn => {
    const active = String(btn.dataset.pid) === String(projectId);
    btn.className = `btn btn-xs ${active ? 'btn-primary' : 'btn-secondary'}`;
  });
  renderPreview();
}

async function loadPreview() {
  try {
    const posts = await api('GET', '/api/posts/preview');
    previewAllPosts = posts;

    // 미리보기 뱃지: generated(승인대기) 포스트 수
    const generatedCount = posts.filter(p => p.status === 'generated').length;
    const previewBadge = document.getElementById('preview-badge');
    if (previewBadge) {
      previewBadge.style.display = generatedCount > 0 ? 'inline' : 'none';
      previewBadge.textContent = generatedCount;
    }

    // Build project filter pills
    const uniqueProjects = Array.from(
      new Map(posts.map(p => [p.project_id, { id: p.project_id, name: p.project_name }])).values()
    );
    const filterContainer = document.getElementById('preview-project-filters');
    if (filterContainer) {
      filterContainer.innerHTML = [
        `<button class="btn btn-xs btn-primary" data-pid="all" onclick="setPreviewProjectFilter('all')">전체</button>`,
        ...uniqueProjects.map(p =>
          `<button class="btn btn-xs btn-secondary" data-pid="${p.id}" onclick="setPreviewProjectFilter(${p.id})">${escHtml(p.name)}</button>`
        ),
      ].join('');
    }

    renderPreview();
  } catch (e) {
    toast('미리보기 로드 실패: ' + e.message, 'error');
  }
}

let collapsedPreviewAccounts = new Set();

function togglePreviewAccount(username) {
  if (collapsedPreviewAccounts.has(username)) {
    collapsedPreviewAccounts.delete(username);
  } else {
    collapsedPreviewAccounts.add(username);
  }
  renderPreview();
}

function renderPreview() {
  const el = document.getElementById('preview-list');
  // 미리보기에는 generated(승인대기) + failed만 표시. approved는 발행대기로 이동됨.
  let posts = previewAllPosts.filter(p => p.status === 'generated' || p.status === 'failed');

  if (previewProjectFilter !== 'all') {
    posts = posts.filter(p => String(p.project_id) === String(previewProjectFilter));
  }
  if (previewTypeFilter === 'scheduled') {
    posts = posts.filter(p => p.source_type !== 'benchmarking');
  } else if (previewTypeFilter === 'benchmarking') {
    posts = posts.filter(p => p.source_type === 'benchmarking');
  }

  if (posts.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">✅</div><p>승인 대기 포스트가 없습니다.<br><span style="font-size:12px">승인된 포스트는 발행대기 탭에서 확인하세요.</span></p></div>';
    return;
  }

  // 계정별 그룹핑
  const byAccount = new Map();
  posts.forEach(p => {
    if (!byAccount.has(p.username)) byAccount.set(p.username, []);
    byAccount.get(p.username).push(p);
  });

  const renderCard = (p) => {
    const isBm = p.source_type === 'benchmarking';
    const mediaPaths = JSON.parse(p.media_paths || '[]');
    const editable = p.status === 'generated' ? 'true' : 'false';
    const scheduledLabel = formatScheduledTime(p.scheduled_time);

    // 벤치마킹: DB의 comment_links 사용 / 일반: comment_content에서 추출
    const bmCommentLinks = isBm ? JSON.parse(p.comment_links || '[]') : [];
    const bmOriginalComment = isBm ? (p.original_comment || '') : '';
    // 일반 포스트 댓글 링크 (기존 방식 유지)
    const regularCommentLinks = isBm ? [] : extractLinks(p.comment_content);

    // 원본 게시글 + 쿠팡 바로가기 링크 바 (벤치마킹 전용)
    const firstBmLink = bmCommentLinks[0] || '';
    const bmLinksBar = isBm && (p.source_url || firstBmLink) ? `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
        ${p.source_url ? `<a href="${escHtml(p.source_url)}" target="_blank" class="btn btn-xs btn-secondary">🔗 원본 게시글</a>` : ''}
        ${firstBmLink ? `<a href="${escHtml(firstBmLink)}" target="_blank" class="btn btn-xs btn-secondary" style="background:var(--accent2);color:#fff;border-color:var(--accent2)">🛒 쿠팡파트너스 바로가기</a>` : ''}
      </div>` : '';

    // ── 미디어 섹션 ─────────────────────────────────────────────────────────
    const mediaItems = mediaPaths.map((src, idx) => {
      const isVideo = /\.(mp4|webm|mov|avi|mkv)$/i.test(src.split('?')[0]);
      const media = isVideo
        ? `<video src="${escHtml(src)}" controls style="max-width:100%;max-height:240px;border-radius:6px;border:1px solid var(--border);display:block"></video>`
        : `<img src="${escHtml(src)}" style="width:160px;height:120px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:pointer;display:block" onclick="window.open(this.src,'_blank')" onerror="this.style.display='none'">`;
      return `
        <div style="position:relative;display:inline-block">
          ${media}
          <button onclick="deleteMedia(${p.id},${idx})" title="삭제"
            style="position:absolute;top:4px;right:4px;width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,0.7);color:#fff;border:none;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center">×</button>
        </div>`;
    }).join('');

    const mediaSection = `
      <div style="margin:10px 0 4px;font-size:11px;color:var(--text2);display:flex;align-items:center;gap:8px">
        <span>🖼 미디어 (${mediaPaths.length}개)</span>
        <button onclick="triggerMediaUpload(${p.id})" class="btn btn-xs btn-secondary">+ 추가</button>
      </div>
      <input type="file" id="media-input-${p.id}" style="display:none" accept="image/*,video/*" onchange="handleMediaUpload(${p.id},this)">
      ${mediaPaths.length > 0 ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">${mediaItems}</div>` : '<div style="margin-bottom:8px;font-size:11px;color:var(--text3)">미디어 없음</div>'}`;

    const contentDisplay = p.generated_content || (isBm ? p.original_content || '' : '');

    // ── 본문 + 미디어 + 댓글: 벤치마킹=2열(원본|재작성), 일반=단일 열 ─────────
    const bodySection = isBm ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px">
        <div style="display:flex;flex-direction:column;min-width:0">
          <div style="font-size:11px;color:var(--text2);margin-bottom:4px;font-weight:600">📄 원본</div>
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:12px;color:var(--text2);white-space:pre-wrap;flex:1;max-height:200px;overflow-y:auto;line-height:1.6">${escHtml(p.original_content || '원본 없음')}</div>
        </div>
        <div style="display:flex;flex-direction:column;min-width:0">
          <div style="font-size:11px;color:var(--text2);margin-bottom:4px;font-weight:600">✏️ 재작성${!p.generated_content ? ' <span style="color:var(--yellow);font-size:10px">⚠ AI 재작성 필요</span>' : ''}</div>
          <div class="post-content" contenteditable="${editable}" id="content-${p.id}" onblur="saveEdit(${p.id})" style="flex:1;max-height:200px;overflow-y:auto;${!contentDisplay ? 'min-height:60px' : ''}" placeholder="내용을 입력하세요">${escHtml(contentDisplay)}</div>
        </div>
      </div>
      ${mediaSection}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:4px">
        <div style="display:flex;flex-direction:column;min-width:0">
          <div style="font-size:11px;color:var(--text2);margin-bottom:4px;font-weight:600">💬 원본 댓글</div>
          <div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12px;color:var(--text2);white-space:pre-wrap;flex:1;max-height:120px;overflow-y:auto;line-height:1.6">${bmOriginalComment ? escHtml(bmOriginalComment) : '<span style="color:var(--text3);font-style:italic">원본 댓글 없음</span>'}</div>
          ${bmCommentLinks.length > 0 ? `
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:5px;align-items:center">
              <span style="font-size:11px;color:var(--text2)">🔗 링크:</span>
              ${bmCommentLinks.map(l => `<a href="${escHtml(l)}" target="_blank" style="font-size:11px;color:var(--accent2);text-decoration:underline;max-width:200px;display:inline-block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(l)}">${escHtml(l.replace(/^https?:\/\//, '').slice(0, 45))}</a>`).join('')}
            </div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;min-width:0">
          <div style="font-size:11px;color:var(--text2);margin-bottom:4px;font-weight:600">✏️ 재작성 댓글 <span style="font-weight:400;color:var(--text3)">(발행 시 게시됨)</span></div>
          <div class="post-comment" contenteditable="${editable}" id="comment-${p.id}" onblur="saveEdit(${p.id})" style="flex:1;${!p.comment_content ? 'min-height:60px' : ''}" placeholder="댓글을 입력하세요 (비워두면 댓글 없이 발행)">${escHtml(p.comment_content || '')}</div>
        </div>
      </div>` : `
      <div style="margin-bottom:6px;font-size:11px;color:var(--text2)">📝 내용</div>
      <div class="post-content" contenteditable="${editable}" id="content-${p.id}" onblur="saveEdit(${p.id})" style="${!contentDisplay ? 'min-height:60px' : ''}" placeholder="내용을 입력하세요">${escHtml(contentDisplay)}</div>`;

    // 일반 포스트 댓글 섹션 (벤치마킹이 아닐 때)
    const regularCommentSection = !isBm ? `
      <div style="margin:8px 0 4px;font-size:11px;color:var(--text2)">💬 댓글</div>
      <div class="post-comment" contenteditable="${editable}" id="comment-${p.id}" onblur="saveEdit(${p.id})" style="${!p.comment_content ? 'min-height:40px' : ''}" placeholder="댓글을 입력하세요">${escHtml(p.comment_content || '')}</div>
      ${regularCommentLinks.length > 0 ? `
        <div style="margin:4px 0 8px;font-size:11px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
          <span style="color:var(--text2)">댓글 링크:</span>
          ${regularCommentLinks.map(l => `<a href="${escHtml(l)}" target="_blank" style="color:var(--accent2);text-decoration:underline">${escHtml(l.replace(/^https?:\/\//, '').slice(0, 50))}</a>`).join('')}
        </div>` : ''}` : '';

    return `
      <div class="preview-card" id="preview-${p.id}" ${p.status === 'failed' ? 'style="border-color:var(--red);border-left:3px solid var(--red)"' : ''}>
        <div class="preview-meta">
          <div class="preview-account">@${escHtml(p.username)}</div>
          <div class="preview-time" style="margin-left:6px">${escHtml(p.project_name)}</div>
          ${isBm ? '<span class="badge badge-purple" style="margin-left:4px">벤치마킹</span>' : ''}
          <div style="margin-left:auto">${statusBadge(p.status)}</div>
        </div>
        <div style="font-size:11px;color:var(--accent2);margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          📅 <span id="time-label-${p.id}" style="cursor:pointer;text-decoration:underline dotted" onclick="editScheduledTime(${p.id})" title="클릭하여 시간 변경">${escHtml(scheduledLabel || '시간 미설정')}</span>
          <span id="time-suffix-${p.id}" style="color:var(--text3)">게시 예정</span>
          <span id="time-edit-${p.id}" style="display:none;align-items:center;gap:4px">
            <input type="datetime-local" id="time-input-${p.id}" style="font-size:11px;padding:2px 4px;border:1px solid var(--border);border-radius:4px;background:var(--surface2);color:var(--text)" onkeydown="if(event.key==='Enter')saveScheduledTime(${p.id});else if(event.key==='Escape')cancelScheduledTimeEdit(${p.id})">
            <button onclick="saveScheduledTime(${p.id})" style="padding:2px 6px;font-size:11px;border-radius:4px;border:1px solid #22c55e;background:transparent;color:#22c55e;cursor:pointer">✓</button>
            <button onclick="cancelScheduledTimeEdit(${p.id})" style="padding:2px 6px;font-size:11px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--text2);cursor:pointer">✗</button>
          </span>
        </div>
        ${bmLinksBar}
        ${p.status === 'failed' && p.error_message ? `
          <div style="padding:8px 10px;background:#450a0a33;border:1px solid var(--red);border-radius:6px;font-size:12px;color:#fca5a5;margin-bottom:10px">
            ⚠️ 실패: ${escHtml(p.error_message)}
          </div>` : ''}
        ${bodySection}
        ${isBm ? '' : mediaSection}
        ${regularCommentSection}
        <div class="preview-actions">
          ${isBm
            ? `<button class="btn btn-secondary btn-sm" onclick="bmRewrite(${p.id})" title="AI로 본문 재작성">🔄 재실행</button>`
            : `<button class="btn btn-secondary btn-sm" onclick="regenerate(${p.id})">🔄 재생성</button>`}
          <button class="btn btn-secondary btn-sm" onclick="skipPost(${p.id})">건너뜀</button>
          <button class="btn btn-secondary btn-sm" onclick="deletePost(${p.id})" style="color:var(--red);border-color:var(--red)">🗑 삭제</button>
          ${p.status === 'generated' ? `
            <button class="btn btn-green btn-sm" onclick="approvePost(${p.id})">✓ 승인</button>
          ` : ''}
          ${p.status === 'failed' ? `
            <button class="btn btn-green btn-sm" onclick="approvePost(${p.id})">✓ 재승인</button>
          ` : ''}
        </div>
      </div>`;
  };

  // 계정별 그룹 헤더 + 토글로 렌더링
  let html = '';
  for (const [username, accountPosts] of byAccount) {
    const isCollapsed = collapsedPreviewAccounts.has(username);
    const failCount = accountPosts.filter(p => p.status === 'failed').length;
    html += `
      <div style="margin-bottom:12px">
        <div onclick="togglePreviewAccount('${escHtml(username)}')" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--surface2);border-radius:${isCollapsed ? '8px' : '8px 8px 0 0'};border:1px solid var(--border);user-select:none">
          <span style="font-weight:600;font-size:14px">@${escHtml(username)}</span>
          <span style="background:var(--accent);color:#fff;border-radius:10px;padding:1px 8px;font-size:11px">${accountPosts.length}개</span>
          ${failCount > 0 ? `<span style="background:var(--red);color:#fff;border-radius:10px;padding:1px 8px;font-size:11px">실패 ${failCount}</span>` : ''}
          <span style="margin-left:auto;color:var(--text2);font-size:12px">${isCollapsed ? '▼ 펼치기' : '▲ 접기'}</span>
        </div>
        <div style="display:${isCollapsed ? 'none' : 'block'}">
          ${accountPosts.map(renderCard).join('')}
        </div>
      </div>`;
  }
  el.innerHTML = html;
}

async function saveEdit(postId) {
  const content = document.getElementById(`content-${postId}`)?.innerText || '';
  const comment = document.getElementById(`comment-${postId}`)?.innerText || '';
  try {
    await api('PUT', `/api/posts/${postId}/content`, { generated_content: content, comment_content: comment });
  } catch (e) { /* silent */ }
}

async function approvePost(id) {
  // 승인 전 예약 시간 체크 — 과거 시간이면 차단하고 시간 변경 안내
  const post = previewAllPosts.find(p => p.id === id);
  if (post?.scheduled_time) {
    const rawTime = String(post.scheduled_time);
    const scheduledDate = rawTime.includes('T')
      ? new Date(rawTime)
      : new Date(rawTime.replace(' ', 'T') + 'Z');
    if (scheduledDate.getTime() <= Date.now()) {
      toast(`⏰ 예약 시간이 과거입니다 (${formatScheduledTime(post.scheduled_time)}). 시간을 먼저 변경해주세요.`, 'error');
      // 시간 편집 UI 열기
      editScheduledTime(id);
      return;
    }
  }
  try {
    await api('POST', `/api/posts/${id}/approve`);
    toast('승인되었습니다. 발행대기 탭에서 예약발행을 진행하세요.', 'success');
    loadPreview();  // 승인된 건 미리보기에서 사라짐
    loadPending();  // 발행대기 뱃지 + 목록 갱신
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
}

async function approveAllGenerated() {
  const posts = await api('GET', '/api/posts/preview');
  const generated = posts.filter(p => p.status === 'generated');
  if (generated.length === 0) { toast('승인 대기 포스트가 없습니다.', 'info'); return; }

  // 과거 시간인 포스트 체크
  const now = Date.now();
  const pastPosts = generated.filter(p => {
    const raw = String(p.scheduled_time);
    const d = raw.includes('T') ? new Date(raw) : new Date(raw.replace(' ', 'T') + 'Z');
    return d.getTime() <= now;
  });
  const validPosts = generated.filter(p => {
    const raw = String(p.scheduled_time);
    const d = raw.includes('T') ? new Date(raw) : new Date(raw.replace(' ', 'T') + 'Z');
    return d.getTime() > now;
  });

  if (validPosts.length === 0) {
    toast(`전체 ${generated.length}개 포스트의 예약 시간이 과거입니다. 미리보기에서 각 포스트의 시간을 변경해주세요.`, 'error');
    return;
  }

  let msg = `${validPosts.length}개 포스트를 승인하시겠습니까?`;
  if (pastPosts.length > 0) msg += `\n\n⚠ 과거 시간 ${pastPosts.length}개는 제외됩니다. 미리보기에서 시간을 변경해주세요.`;
  msg += '\n\n승인 후 발행대기 탭에서 예약하기를 실행하세요.';
  if (!confirm(msg)) return;

  try {
    let ok = 0;
    for (const p of validPosts) {
      await api('POST', `/api/posts/${p.id}/approve`);
      ok++;
    }
    if (pastPosts.length > 0) {
      toast(`${ok}개 승인 완료. 과거 시간 ${pastPosts.length}개는 제외되었습니다. 시간을 변경 후 다시 승인해주세요.`, 'info');
    } else {
      toast(`${ok}개 포스트가 승인되었습니다. 발행대기 탭에서 예약하기를 실행하세요.`, 'success');
    }
    loadPreview();
    loadPending();
    loadDashboard();
    loadHistory();
  } catch (e) { toast('일부 승인 실패: ' + e.message, 'error'); }
}

async function returnPost(id) {
  try {
    await api('POST', `/api/posts/${id}/return`);
    toast('반려되었습니다. 미리보기에서 다시 확인하세요.', 'info');
    loadPreview();
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
}

async function skipPost(id) {
  try {
    await api('POST', `/api/posts/${id}/skip`);
    toast('포스트를 건너뛰었습니다.', 'info');
    loadPreview();
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
}

async function deletePost(id) {
  if (!confirm('이 포스트를 삭제하시겠습니까? 미디어 파일도 함께 삭제됩니다.')) return;
  try {
    await api('DELETE', `/api/posts/${id}`);
    toast('삭제되었습니다.', 'success');
    loadPreview();
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
}

async function bmRewrite(id) {
  const btn = document.querySelector(`#preview-${id} .preview-actions button[onclick="bmRewrite(${id})"]`);
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 재작성 중...'; }
  try {
    const result = await api('POST', `/api/posts/${id}/bm-rewrite`);
    const el = document.getElementById(`content-${id}`);
    if (el) el.innerText = result.generated_content;
    // 노란색 경고 문구 제거
    const warn = el?.previousElementSibling?.querySelector('span[style*="yellow"]');
    if (warn) warn.remove();
    toast('AI 재작성 완료!', 'success');
  } catch (e) {
    toast('재작성 실패: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

// ─── 게시 시간 변경 ───────────────────────────────────────────────────────────

function editScheduledTime(postId) {
  const post = previewAllPosts.find(p => p.id === postId);
  const label = document.getElementById(`time-label-${postId}`);
  const suffix = document.getElementById(`time-suffix-${postId}`);
  const editWrap = document.getElementById(`time-edit-${postId}`);
  const input = document.getElementById(`time-input-${postId}`);
  if (!label || !editWrap || !input) return;

  // scheduled_time → datetime-local value (YYYY-MM-DDTHH:MM, 로컬 기준)
  let val = '';
  if (post && post.scheduled_time) {
    const raw = post.scheduled_time;
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      const pad = n => String(n).padStart(2, '0');
      val = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }

  input.value = val;
  label.style.display = 'none';
  if (suffix) suffix.style.display = 'none';
  editWrap.style.display = 'flex';
  input.focus();
}

async function saveScheduledTime(postId) {
  const input = document.getElementById(`time-input-${postId}`);
  if (!input || !input.value) { toast('시간을 선택하세요.', 'error'); return; }

  // datetime-local 값은 로컬 시간 → UTC ISO string으로 변환
  const localDate = new Date(input.value);
  if (isNaN(localDate.getTime())) { toast('올바른 날짜/시간 형식이 아닙니다.', 'error'); return; }
  const isoStr = localDate.toISOString();

  try {
    const r = await fetch(`/api/posts/${postId}/scheduled-time`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduled_time: isoStr }),
    });

    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}

    if (!r.ok) throw new Error(data.error || `서버 오류 (${r.status})`);

    // 캐시만 업데이트 (DOM 재구성 없음 → 편집 내용 유지)
    const post = previewAllPosts.find(p => p.id === postId);
    if (post) post.scheduled_time = isoStr;

    toast('게시 시간이 변경되었습니다.', 'success');

    // 시간 표시만 인-플레이스 업데이트 (renderPreview 호출 금지)
    const label = document.getElementById(`time-label-${postId}`);
    const suffix = document.getElementById(`time-suffix-${postId}`);
    const editWrap = document.getElementById(`time-edit-${postId}`);
    if (label) label.textContent = formatScheduledTime(isoStr);
    if (label) label.style.display = '';
    if (suffix) suffix.style.display = '';
    if (editWrap) editWrap.style.display = 'none';
  } catch (e) {
    toast('시간 변경 실패: ' + e.message, 'error');
  }
}

function cancelScheduledTimeEdit(postId) {
  const label = document.getElementById(`time-label-${postId}`);
  const suffix = document.getElementById(`time-suffix-${postId}`);
  const editWrap = document.getElementById(`time-edit-${postId}`);
  if (label) label.style.display = '';
  if (suffix) suffix.style.display = '';
  if (editWrap) editWrap.style.display = 'none';
}

// ─── 미디어 관리 ──────────────────────────────────────────────────────────────

function triggerMediaUpload(postId) {
  const input = document.getElementById(`media-input-${postId}`);
  if (input) input.click();
}

async function handleMediaUpload(postId, input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  if (file.size > 50 * 1024 * 1024) { toast('파일이 너무 큽니다 (최대 50MB)', 'error'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = async function(e) {
    const base64 = e.target.result.split(',')[1];
    try {
      toast('미디어 업로드 중...', 'info');
      await api('POST', `/api/posts/${postId}/media/add`, { filename: file.name, data: base64 });
      toast('미디어 추가 완료', 'success');
      loadPreview();
    } catch (err) {
      toast('미디어 추가 실패: ' + err.message, 'error');
    }
    input.value = '';
  };
  reader.readAsDataURL(file);
}

async function deleteMedia(postId, index) {
  if (!confirm('이 미디어를 삭제하시겠습니까?')) return;
  try {
    await api('DELETE', `/api/posts/${postId}/media/${index}`);
    toast('미디어 삭제됨', 'success');
    loadPreview();
  } catch (err) {
    toast('미디어 삭제 실패: ' + err.message, 'error');
  }
}

async function approveAll() {
  try {
    const result = await api('POST', '/api/posts/approve-all');
    toast(`${result.approved}개 포스트를 승인했습니다.`, 'success');
    loadPreview();
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
}

async function regenerate(id) {
  toast('콘텐츠 재생성 중... (AI 브라우저가 열립니다)', 'info');
  try {
    await api('POST', `/api/posts/${id}/regenerate`);
    toast('재생성 완료!', 'success');
    loadPreview();
    loadDashboard();
  } catch (e) { toast(e.message, 'error'); }
}

async function viewPost(id) {
  try {
    const post = await api('GET', `/api/posts/${id}`);
    const logsHtml = post.logs && post.logs.length > 0
      ? post.logs.map(l => `
          <div style="font-size:11px;padding:4px 0;border-bottom:1px solid var(--border);color:${l.level === 'error' ? '#fca5a5' : 'var(--text2)'}">
            <span style="color:var(--text3)">${(l.created_at || '').substring(11, 19)}</span>
            [${l.level.toUpperCase()}] ${l.message}
          </div>`).join('')
      : '<div style="color:var(--text3);font-size:12px">로그 없음</div>';

    showTestModal(`포스트 #${post.id} 상세`, `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;margin-bottom:14px;padding:10px;background:var(--surface2);border-radius:8px">
        <span style="color:var(--text2)">상태</span><span>${statusBadge(post.status)}</span>
        <span style="color:var(--text2)">예약 시간</span><span>${formatTime(post.scheduled_time)}</span>
        ${post.error_message ? `<span style="color:var(--text2)">오류</span><span style="color:#fca5a5">${post.error_message}</span>` : ''}
      </div>
      ${post.generated_content ? `
        <div style="margin-bottom:6px;font-size:11px;color:var(--text2)">메인 포스트</div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;white-space:pre-wrap;max-height:180px;overflow-y:auto;margin-bottom:12px">${post.generated_content}</div>
      ` : ''}
      ${post.comment_content ? `
        <div style="margin-bottom:6px;font-size:11px;color:var(--text2)">댓글</div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;white-space:pre-wrap;max-height:100px;overflow-y:auto;margin-bottom:12px">${post.comment_content}</div>
      ` : ''}
      <div style="margin-bottom:6px;font-size:11px;color:var(--text2)">실행 로그</div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;max-height:150px;overflow-y:auto">${logsHtml}</div>
      ${post.status === 'failed' || post.status === 'pending_generation' ? `
        <div style="margin-top:12px">
          <button class="btn btn-secondary btn-sm" onclick="closeModal('modal-test');regenerate(${post.id})">🔄 재생성</button>
        </div>` : ''}
    `);
  } catch (e) {
    toast('포스트 정보 로드 실패: ' + e.message, 'error');
  }
}

async function postNow(id) {
  if (!confirm('지금 즉시 포스팅하시겠습니까?')) return;
  toast('포스팅 중... 브라우저가 열립니다.', 'info');
  try {
    await api('POST', `/api/posts/${id}/post-now`);
    toast('포스팅 완료!', 'success');
    loadDashboard();
    loadPreview();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── 발행대기 (Pending Schedule) ──────────────────────────────────────────────
let pendingAllPosts = [];
let pendingSelectedIds = new Set();

async function loadPending() {
  try {
    const posts = await api('GET', '/api/posts/preview');
    // 승인된 포스트만 (approved 상태)
    pendingAllPosts = posts.filter(p => p.status === 'approved');
    const generatedCount = posts.filter(p => p.status === 'generated').length;
    pendingSelectedIds.clear();

    // 사이드바 뱃지 업데이트
    const badge = document.getElementById('pending-badge');
    if (badge) {
      if (pendingAllPosts.length > 0) {
        badge.style.display = 'inline';
        badge.textContent = pendingAllPosts.length;
      } else {
        badge.style.display = 'none';
      }
    }

    // 승인 대기 알림 배너
    const noticeEl = document.getElementById('pending-generated-notice');
    if (noticeEl) {
      if (generatedCount > 0) {
        noticeEl.style.display = 'flex';
        noticeEl.innerHTML = `
          <span style="font-size:15px">⚠️</span>
          <span>미리보기에 <strong>${generatedCount}개</strong> 포스트가 승인 대기 중입니다. 승인 후 여기서 예약하세요.</span>
          <div style="margin-left:auto;display:flex;gap:6px">
            <button class="btn btn-xs btn-secondary" onclick="navigate('preview')">미리보기로 이동</button>
            <button class="btn btn-xs btn-green" onclick="approveAllGenerated()">전체 승인</button>
          </div>`;
      } else {
        noticeEl.style.display = 'none';
      }
    }

    renderPending();
    updatePendingActions();
  } catch (e) {
    toast('발행대기 로드 실패: ' + e.message, 'error');
  }
}

function renderPending() {
  const el = document.getElementById('pending-list');
  if (!el) return;

  if (pendingAllPosts.length === 0) {
    el.innerHTML = '<div class="empty"><div class="empty-icon">✅</div><p>발행대기 중인 포스트가 없습니다.<br>미리보기에서 포스트를 승인하면 여기에 표시됩니다.</p></div>';
    return;
  }

  // 프로젝트 > 계정 순으로 그룹핑
  const byProject = new Map();
  for (const p of pendingAllPosts) {
    const projKey = p.project_id;
    if (!byProject.has(projKey)) byProject.set(projKey, { name: p.project_name, accounts: new Map() });
    const proj = byProject.get(projKey);
    if (!proj.accounts.has(p.account_id)) proj.accounts.set(p.account_id, { username: p.username, posts: [] });
    proj.accounts.get(p.account_id).posts.push(p);
  }

  let html = '';
  for (const [, proj] of byProject) {
    html += `<div style="margin-bottom:24px">
      <div style="font-size:13px;font-weight:600;color:var(--accent2);margin-bottom:12px;display:flex;align-items:center;gap:8px">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        ${escHtml(proj.name)}
      </div>`;

    for (const [, acc] of proj.accounts) {
      html += `<div style="margin-bottom:16px;margin-left:12px">
        <div style="font-size:12px;font-weight:500;color:var(--text2);margin-bottom:8px;display:flex;align-items:center;gap:6px">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          @${escHtml(acc.username)}
          <span style="color:var(--text3)">(${acc.posts.length}개)</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">`;

      for (const post of acc.posts) {
        const isBm = post.source_type === 'benchmarking';
        const mediaPaths = JSON.parse(post.media_paths || '[]');
        const checked = pendingSelectedIds.has(post.id) ? 'checked' : '';
        const scheduledLabel = formatScheduledTime(post.scheduled_time);
        const preview = (post.generated_content || '').replace(/</g, '&lt;').substring(0, 120);

        html += `
          <div class="card-sm" id="pending-card-${post.id}" style="display:flex;gap:12px;align-items:flex-start;border:1px solid ${pendingSelectedIds.has(post.id) ? 'var(--accent)' : 'var(--border)'}">
            <input type="checkbox" ${checked} onchange="togglePendingPost(${post.id}, this.checked)"
              style="width:16px;height:16px;margin-top:3px;flex-shrink:0;cursor:pointer">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">
                <span style="font-size:12px;color:var(--accent2);font-weight:500">📅 ${escHtml(scheduledLabel)}</span>
                ${isBm ? '<span class="badge badge-purple">벤치마킹</span>' : ''}
                ${mediaPaths.length > 0 ? `<span class="badge badge-gray">🖼 미디어 ${mediaPaths.length}개</span>` : ''}
              </div>
              <div style="font-size:12px;color:var(--text);line-height:1.5;white-space:pre-wrap;max-height:80px;overflow:hidden">${preview}${post.generated_content && post.generated_content.length > 120 ? '...' : ''}</div>
              ${post.comment_content ? `<div style="font-size:11px;color:var(--text2);margin-top:4px">💬 ${escHtml((post.comment_content || '').substring(0, 60))}${post.comment_content.length > 60 ? '...' : ''}</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
              <button class="btn btn-xs btn-secondary" onclick="returnPost(${post.id});loadPending()">↩ 반려</button>
            </div>
          </div>`;
      }

      html += `</div></div></div>`;
    }
    html += `</div>`;
  }

  el.innerHTML = html;
}

function togglePendingPost(id, checked) {
  if (checked) {
    pendingSelectedIds.add(id);
  } else {
    pendingSelectedIds.delete(id);
  }
  // 카드 테두리 업데이트
  const card = document.getElementById(`pending-card-${id}`);
  if (card) card.style.border = `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`;
  updatePendingActions();
}

function toggleSelectAllPending(checked) {
  pendingSelectedIds.clear();
  if (checked) {
    pendingAllPosts.forEach(p => pendingSelectedIds.add(p.id));
  }
  // 체크박스 및 카드 테두리 업데이트
  document.querySelectorAll('[id^="pending-card-"] input[type="checkbox"]').forEach(cb => {
    cb.checked = checked;
  });
  document.querySelectorAll('[id^="pending-card-"]').forEach(card => {
    const id = parseInt(card.id.replace('pending-card-', ''));
    card.style.border = `1px solid ${pendingSelectedIds.has(id) ? 'var(--accent)' : 'var(--border)'}`;
  });
  updatePendingActions();
}

function updatePendingActions() {
  const count = pendingSelectedIds.size;
  const nativeBtn = document.getElementById('batch-native-btn');
  const autoBtn = document.getElementById('batch-auto-btn');
  const nowBtn = document.getElementById('batch-now-btn');
  const countEl = document.getElementById('pending-selected-count');
  if (nativeBtn) nativeBtn.disabled = count === 0;
  if (autoBtn) autoBtn.disabled = count === 0;
  if (nowBtn) nowBtn.disabled = count === 0;
  if (countEl) countEl.textContent = count > 0 ? `${count}개 선택됨` : '선택 없음';
  // 전체 선택 체크박스 상태
  const selectAll = document.getElementById('select-all-pending');
  if (selectAll) {
    selectAll.checked = count > 0 && count === pendingAllPosts.length;
    selectAll.indeterminate = count > 0 && count < pendingAllPosts.length;
  }
}

// Threads 네이티브 예약: publish_mode='native' 설정 후 배치 예약 실행 (PC 꺼도 발행됨)
async function batchScheduleNative() {
  if (pendingSelectedIds.size === 0) return;
  const postIds = [...pendingSelectedIds];
  const btn = document.getElementById('batch-native-btn');
  const statusPanel = document.getElementById('batch-status-panel');

  try {
    if (btn) { btn.disabled = true; btn.textContent = '예약 시작 중...'; }
    if (statusPanel) statusPanel.style.display = 'flex';

    // publish_mode를 'native'로 설정한 후 배치 예약 실행
    await api('POST', '/api/posts/publish-mode', { postIds, mode: 'native' });
    await api('POST', '/api/posts/batch-schedule', { postIds });
    toast(`${postIds.length}개 포스트 Threads 예약 시작됨. 브라우저가 열립니다.`, 'success');

    // 완료될 때까지 주기적으로 상태 체크 (최대 20분 = 300회 × 4초)
    let pollCount = 0;
    const BTN_HTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="10" y1="16" x2="14" y2="16"/></svg> Threads 예약';
    const stopPolling = (isError) => {
      clearInterval(pollInterval);
      if (statusPanel) statusPanel.style.display = 'none';
      if (btn) { btn.disabled = false; btn.innerHTML = BTN_HTML; }
      if (isError) toast('배치 예약 실패 또는 연결 끊김. 발행대기 탭에서 결과를 확인하세요.', 'error');
    };
    const pollInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > 300) { stopPolling(true); return; }
      try {
        const status = await api('GET', '/api/posts/batch-schedule/status');
        if (!status.running) {
          stopPolling(false);
          const s = status.lastSummary;
          if (s) {
            if (s.failed === 0) toast(`배치 예약 완료! (${s.success}개 성공)`, 'success');
            else if (s.success === 0) toast(`배치 예약 실패 (${s.failed}개 실패). 발행대기 탭에서 확인하세요.`, 'error');
            else toast(`배치 예약 부분 완료 (성공 ${s.success}개 / 실패 ${s.failed}개)`, 'info');
          } else {
            toast('배치 예약 완료!', 'success');
          }
          loadPending();
          loadDashboard();
        }
      } catch { /* 일시적 네트워크 오류 → 다음 주기에 재시도 */ }
    }, 4000);

  } catch (e) {
    toast('배치 예약 실패: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="10" y1="16" x2="14" y2="16"/></svg> Threads 예약'; }
    if (statusPanel) statusPanel.style.display = 'none';
  }
}

// 즉시 발행: 선택한 포스트를 지금 바로 발행 (브라우저가 열림)
async function batchPostNow() {
  if (pendingSelectedIds.size === 0) return;
  const postIds = [...pendingSelectedIds];
  if (!confirm(`선택한 ${postIds.length}개 포스트를 지금 즉시 발행하시겠습니까?\n브라우저가 열립니다.`)) return;

  const btn = document.getElementById('batch-now-btn');
  if (btn) { btn.disabled = true; btn.textContent = '발행 중...'; }
  toast(`${postIds.length}개 포스트 즉시 발행 시작. 브라우저가 열립니다.`, 'info');

  let ok = 0, fail = 0;
  for (const id of postIds) {
    try {
      await api('POST', `/api/posts/${id}/post-now`);
      ok++;
    } catch (e) {
      fail++;
      console.error(`즉시 발행 실패 #${id}:`, e.message);
    }
  }
  if (btn) { btn.disabled = false; btn.textContent = '▶ 즉시 발행'; }
  if (fail === 0) toast(`즉시 발행 완료! (${ok}개)`, 'success');
  else toast(`즉시 발행 완료: 성공 ${ok}개 / 실패 ${fail}개`, fail === ok ? 'error' : 'info');
  loadPending();
  loadDashboard();
}

// 자동 발행: publish_mode='auto' 설정 → 지정 시간에 서버가 직접 발행 (PC 켜져있어야 함)
async function batchAutoPublish() {
  if (pendingSelectedIds.size === 0) return;
  const postIds = [...pendingSelectedIds];
  try {
    await api('POST', '/api/posts/publish-mode', { postIds, mode: 'auto' });
    toast(`${postIds.length}개 포스트가 자동 발행 모드로 설정되었습니다. 지정 시간에 서버가 발행합니다.`, 'success');
    loadPending();
  } catch (e) {
    toast('자동 발행 설정 실패: ' + e.message, 'error');
  }
}

// ─── History ──────────────────────────────────────────────────────────────────
async function loadHistory() {
  const accountSel = document.getElementById('history-filter-account');
  const projectSel = document.getElementById('history-filter-project');
  const statusSel = document.getElementById('history-filter-status');
  const params = new URLSearchParams();
  if (accountSel?.value) params.set('account_id', accountSel.value);
  if (projectSel?.value) params.set('project_id', projectSel.value);
  if (statusSel?.value) params.set('status', statusSel.value);

  try {
    const [posts, dailyCounts] = await Promise.all([
      api('GET', '/api/posts/recent' + (params.toString() ? '?' + params : '')),
      api('GET', '/api/posts/daily-counts'),
    ]);

    // 필터 드롭다운 옵션 동적 생성 (첫 로드 시 전체 데이터로 채움)
    if (!accountSel?.dataset.populated) {
      const allPosts = await api('GET', '/api/posts/recent');
      const accounts = [...new Map(allPosts.map(p => [p.account_id, p])).values()];
      const projects = [...new Map(allPosts.map(p => [p.project_id, p])).values()];
      if (accountSel) {
        accountSel.dataset.populated = '1';
        accounts.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.account_id;
          opt.textContent = '@' + p.username;
          accountSel.appendChild(opt);
        });
      }
      if (projectSel) {
        projectSel.dataset.populated = '1';
        projects.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.project_id;
          opt.textContent = p.project_name;
          projectSel.appendChild(opt);
        });
      }
    }

    // 오늘 포스트 섹션
    const todayEl = document.getElementById('history-today-section');
    if (todayEl) {
      const today = new Date().toLocaleDateString('ko-KR');
      // posted_at(실제 발행/예약 시점) 기준. 없으면 scheduled_time 사용. created_at은 생성시점이라 부정확.
      const todayPosts = posts.filter(p => {
        if (!['posted', 'scheduled'].includes(p.status)) return false;
        const rawTs = p.posted_at || p.scheduled_time;
        if (!rawTs) return false;
        const iso = rawTs.includes('T') ? rawTs : rawTs.replace(' ', 'T') + 'Z';
        return new Date(iso).toLocaleDateString('ko-KR') === today;
      });
      if (todayPosts.length > 0) {
        todayEl.innerHTML = `
          <div class="card" style="margin-bottom:16px">
            <div style="font-size:13px;font-weight:600;margin-bottom:10px;color:var(--accent2)">📅 오늘 포스트 (${todayPosts.length}개)</div>
            <div style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
              ${todayPosts.map(p => `
                <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;background:var(--surface2);border-radius:6px;font-size:12px">
                  <span style="color:var(--text2);white-space:nowrap">${formatTime(p.posted_at || p.created_at)}</span>
                  <span style="color:var(--text2)">@${escHtml(p.username)}</span>
                  ${statusBadge(p.status)}
                  <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)">${escHtml((p.generated_content || '').substring(0, 80))}</span>
                  ${p.post_url ? `<a href="${p.post_url}" target="_blank" style="color:var(--accent2);flex-shrink:0">링크</a>` : ''}
                </div>
              `).join('')}
            </div>
          </div>`;
      } else {
        todayEl.innerHTML = '';
      }
    }

    // 캘린더 섹션 (일별 포스팅 수)
    const calEl = document.getElementById('history-calendar-section');
    if (calEl && dailyCounts.length > 0) {
      const rows = dailyCounts.slice(0, 30);
      calEl.innerHTML = `
        <div class="card">
          <div style="font-size:13px;font-weight:600;margin-bottom:10px">📊 일별 발행 현황 (최근 30일, 예약됨+게시완료)</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${rows.map(r => {
              const d = new Date(r.day + 'T00:00:00');
              const label = d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
              const pct = Math.min(r.total / 5, 1);
              const bg = pct === 0 ? 'var(--surface2)' : `rgba(124,58,237,${0.15 + pct * 0.75})`;
              return `<div title="${label}: 총 ${r.total}개 (발행 ${r.posted}, 예약 ${r.scheduled})" style="
                width:52px;padding:6px 4px;border-radius:6px;background:${bg};text-align:center;cursor:default;border:1px solid var(--border)">
                <div style="font-size:10px;color:var(--text2)">${label}</div>
                <div style="font-size:14px;font-weight:700;color:${r.total > 0 ? 'var(--accent2)' : 'var(--text3)'}">${r.total}</div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
    } else if (calEl) {
      calEl.innerHTML = '';
    }

    const el = document.getElementById('history-table');
    if (posts.length === 0) {
      el.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><p>포스트 기록이 없습니다.</p></div>';
    } else {
      el.innerHTML = `<table>
        <thead><tr><th>발행시간</th><th>계정</th><th>프로젝트</th><th>상태</th><th>내용</th><th>URL</th></tr></thead>
        <tbody>${posts.map(p => `
          <tr>
            <td style="white-space:nowrap">${formatTime(p.posted_at || p.scheduled_time || p.created_at)}</td>
            <td>@${escHtml(p.username)}</td>
            <td>${escHtml(p.project_name)}</td>
            <td>${statusBadge(p.status)}</td>
            <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml((p.generated_content || '').substring(0,100)) || '-'}</td>
            <td>${p.post_url ? `<a href="${p.post_url}" target="_blank" style="color:var(--accent2)">링크</a>` : '-'}</td>
          </tr>
        `).join('')}</tbody>
      </table>`;
    }
  } catch (e) { toast('기록 로드 실패: ' + e.message, 'error'); }
}

// ─── Projects ─────────────────────────────────────────────────────────────────
async function loadProjects() {
  try {
    const projects = await api('GET', '/api/projects');
    cachedProjects = projects; // editProject에서 재사용
    const el = document.getElementById('projects-list');
    if (projects.length === 0) {
      el.innerHTML = '<div class="empty"><div class="empty-icon">📁</div><p>프로젝트가 없습니다. 추가해보세요.</p></div>';
      return;
    }
    el.innerHTML = projects.map(p => `
      <div class="card" style="margin-bottom:12px">
        <div class="flex-between">
          <div>
            <div style="font-weight:600;font-size:15px">${escHtml(p.name)}</div>
            ${p.description ? `<div class="text-muted text-sm mt-8">${escHtml(p.description)}</div>` : ''}
          </div>
          <div class="flex gap-8">
            <button class="btn btn-sm btn-secondary" onclick="openProjectDetail(${p.id})">설정</button>
            <button class="btn btn-sm btn-secondary" onclick="editProject(${p.id})">편집</button>
            <button class="btn btn-sm btn-red" onclick="deleteProject(${p.id})">삭제</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (e) { toast(e.message, 'error'); }
}

function openProjectModal(id, name, desc) {
  editingId = id || null;
  document.getElementById('modal-project-title').textContent = id ? '프로젝트 수정' : '새 프로젝트';
  document.getElementById('proj-name').value = name || '';
  document.getElementById('proj-desc').value = desc || '';
  openModal('modal-project');
}

// id만 받아서 cachedProjects에서 name/desc 조회 (특수문자 onclick 깨짐 방지)
function editProject(id) {
  const p = cachedProjects.find(x => x.id === id);
  if (!p) return toast('프로젝트 정보를 찾을 수 없습니다.', 'error');
  openProjectModal(p.id, p.name, p.description || '');
}

async function saveProject() {
  const name = document.getElementById('proj-name').value.trim();
  const description = document.getElementById('proj-desc').value.trim();
  if (!name) return toast('프로젝트 이름을 입력하세요.', 'error');

  try {
    if (editingId) {
      await api('PUT', `/api/projects/${editingId}`, { name, description, is_active: 1 });
      toast('프로젝트가 수정되었습니다.', 'success');
    } else {
      await api('POST', '/api/projects', { name, description });
      toast('프로젝트가 생성되었습니다.', 'success');
    }
    closeModal('modal-project');
    loadProjects();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteProject(id) {
  if (!confirm('프로젝트를 삭제하면 관련 계정, AI 설정, 스케줄이 모두 삭제됩니다. 계속하시겠습니까?')) return;
  try {
    await api('DELETE', `/api/projects/${id}`);
    toast('삭제되었습니다.', 'success');
    loadProjects();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── Project Detail ───────────────────────────────────────────────────────────
async function openProjectDetail(id) {
  currentProjectId = id;
  const p = cachedProjects.find(x => x.id === id);
  document.getElementById('modal-detail-title').textContent = p ? `${escHtml(p.name)} - 설정` : '프로젝트 설정';
  openModal('modal-project-detail');
  switchTab(document.querySelector('#modal-project-detail .tab'), 'tab-accounts');
  await loadAccounts();
}

function switchTab(el, tabId) {
  document.querySelectorAll('#modal-project-detail .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['tab-accounts', 'tab-ai', 'tab-template', 'tab-benchmarking', 'tab-schedules'].forEach(t => {
    document.getElementById(t).style.display = t === tabId ? 'block' : 'none';
  });
  if (tabId === 'tab-ai') loadAIConfigs();
  if (tabId === 'tab-template') loadTemplates();
  if (tabId === 'tab-benchmarking') loadBmTab();
  if (tabId === 'tab-schedules') loadProjectSchedules();
}

// ─── Accounts ─────────────────────────────────────────────────────────────────
async function loadAccounts() {
  const accounts = await api('GET', `/api/projects/${currentProjectId}/accounts`);
  const el = document.getElementById('accounts-list');
  if (accounts.length === 0) {
    el.innerHTML = '<div class="empty" style="padding:24px"><p>계정이 없습니다.</p></div>';
    return;
  }
  el.innerHTML = accounts.map(a => {
    const hasToken = !!a.access_token;
    return `
    <div class="card-sm" style="margin-bottom:8px">
      <div class="flex-between">
        <div>
          <div style="font-weight:500;display:flex;align-items:center;gap:8px">
            <span onclick="loginAccount(${a.id})" title="클릭하면 Threads 브라우저로 열립니다"
              style="cursor:pointer;color:var(--accent2);text-decoration:underline;text-underline-offset:2px">@${escHtml(a.username)}</span>
            ${a.display_name ? `<span class="text-muted" style="font-weight:400">(${escHtml(a.display_name)})</span>` : ''}
            ${hasToken
              ? `<span class="badge badge-green" style="font-size:10px;padding:2px 7px">API 연결됨</span>`
              : `<span class="badge badge-gray" style="font-size:10px;padding:2px 7px">API 미연결</span>`}
          </div>
          <div class="text-sm text-muted mt-8">프로필: ${escHtml(a.profile_dir)}</div>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-xs" style="background:#1e3a5f;color:#60a5fa" onclick="checkAccountLogin(${a.id})">로그인 확인</button>
          <button class="btn btn-xs btn-secondary" onclick="loginAccount(${a.id})">로그인 설정</button>
          <button class="btn btn-xs ${hasToken ? 'btn-green' : 'btn-secondary'}" onclick="openApiTokenModal(${a.id},'${escHtml(a.username)}',${hasToken})">API 토큰</button>
          <button class="btn btn-xs btn-red" onclick="deleteAccount(${a.id})">삭제</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function openAddAccount() { openModal('modal-account'); document.getElementById('acc-username').value = ''; document.getElementById('acc-display').value = ''; }

async function saveAccount() {
  const username = document.getElementById('acc-username').value.trim();
  const display_name = document.getElementById('acc-display').value.trim();
  if (!username) return toast('유저네임을 입력하세요.', 'error');
  try {
    await api('POST', `/api/projects/${currentProjectId}/accounts`, { username, display_name });
    toast('계정이 추가되었습니다. "로그인 설정" 버튼으로 로그인하세요.', 'success');
    closeModal('modal-account');
    loadAccounts();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteAccount(id) {
  if (!confirm('계정을 삭제하시겠습니까?')) return;
  await api('DELETE', `/api/projects/${currentProjectId}/accounts/${id}`);
  toast('삭제되었습니다.', 'success');
  loadAccounts();
}

async function loginAccount(id) {
  toast('브라우저가 열립니다. Threads에 로그인 후 창을 닫으세요.', 'info');
  try {
    await api('POST', `/api/posts/login/account/${id}`);
  } catch (e) { toast(e.message, 'error'); }
}

// ─── API 토큰 관리 ────────────────────────────────────────────────────────────
let apiTokenAccountId = null;

function openApiTokenModal(accountId, username, hasToken) {
  apiTokenAccountId = accountId;
  document.getElementById('api-token-input').value = '';
  document.getElementById('api-token-input').type = 'password';

  const statusEl = document.getElementById('modal-api-token-status');
  if (hasToken) {
    statusEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;background:#14532d22;border:1px solid #16a34a44;border-radius:8px;padding:10px 14px">
        <span style="color:var(--green);font-size:15px">✓</span>
        <span style="font-size:13px;color:var(--green)">@${escHtml(username)} 계정에 API 토큰이 연결되어 있습니다.</span>
      </div>`;
    document.getElementById('api-token-remove-btn').style.display = 'inline-flex';
  } else {
    statusEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 14px">
        <span style="color:var(--text2);font-size:13px">@${escHtml(username)} 계정의 API 토큰을 등록하세요.</span>
      </div>`;
    document.getElementById('api-token-remove-btn').style.display = 'none';
  }

  openModal('modal-api-token');
}

async function saveApiToken() {
  const token = document.getElementById('api-token-input').value.trim();
  if (!token) return toast('토큰을 입력하세요.', 'error');

  try {
    await api('PUT', `/api/projects/${currentProjectId}/accounts/${apiTokenAccountId}/token`, { access_token: token });
    toast('API 토큰이 저장되었습니다.', 'success');
    closeModal('modal-api-token');
    loadAccounts();
  } catch (e) { toast('토큰 저장 실패: ' + e.message, 'error'); }
}

async function removeApiToken() {
  if (!confirm('API 토큰을 삭제하시겠습니까? 이후 브라우저 방식으로만 발행됩니다.')) return;
  try {
    await api('DELETE', `/api/projects/${currentProjectId}/accounts/${apiTokenAccountId}/token`);
    toast('토큰이 삭제되었습니다.', 'success');
    closeModal('modal-api-token');
    loadAccounts();
  } catch (e) { toast(e.message, 'error'); }
}

// ─── AI Configs ───────────────────────────────────────────────────────────────
async function loadAIConfigs() {
  const configs = await api('GET', `/api/projects/${currentProjectId}/ai-configs`);
  const el = document.getElementById('ai-list');
  if (configs.length === 0) {
    el.innerHTML = '<div class="empty" style="padding:24px"><p>AI 설정이 없습니다.</p></div>';
    return;
  }
  el.innerHTML = configs.map(c => `
    <div class="card-sm flex-between" style="margin-bottom:8px">
      <div>
        <div style="font-weight:500">${c.name} <span class="badge badge-purple">${c.ai_type}</span></div>
        <div class="text-sm text-muted mt-8">${c.url}</div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-xs btn-green" onclick="testAIGenerate(${c.id})">생성 테스트</button>
        <button class="btn btn-xs btn-secondary" onclick="loginAI(${c.id})">로그인 설정</button>
        <button class="btn btn-xs btn-red" onclick="deleteAIConfig(${c.id})">삭제</button>
      </div>
    </div>
  `).join('');
}

function openAddAI() {
  document.getElementById('ai-name').value = '';
  document.getElementById('ai-type').value = 'claude';
  document.getElementById('ai-url').value = 'https://claude.ai/new';
  document.getElementById('custom-selectors').style.display = 'none';
  openModal('modal-ai');
}

function onAITypeChange() {
  const type = document.getElementById('ai-type').value;
  const urlMap = { claude: 'https://claude.ai/new', gemini: 'https://gemini.google.com/app', genspark: 'https://www.genspark.ai/', custom: '' };
  document.getElementById('ai-url').value = urlMap[type] || '';
  document.getElementById('custom-selectors').style.display = type === 'custom' ? 'block' : 'none';
}

async function saveAI() {
  const name = document.getElementById('ai-name').value.trim();
  const ai_type = document.getElementById('ai-type').value;
  const url = document.getElementById('ai-url').value.trim();
  if (!name || !url) return toast('이름과 URL을 입력하세요.', 'error');

  const body = {
    name, ai_type, url,
    input_selector: document.getElementById('ai-input-sel')?.value || '',
    submit_selector: document.getElementById('ai-submit-sel')?.value || '',
    output_selector: document.getElementById('ai-output-sel')?.value || '',
  };

  try {
    await api('POST', `/api/projects/${currentProjectId}/ai-configs`, body);
    toast('AI 설정이 추가되었습니다. "로그인 설정"을 클릭해 로그인하세요.', 'success');
    closeModal('modal-ai');
    loadAIConfigs();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteAIConfig(id) {
  if (!confirm('삭제하시겠습니까?')) return;
  await api('DELETE', `/api/projects/${currentProjectId}/ai-configs/${id}`);
  toast('삭제되었습니다.', 'success');
  loadAIConfigs();
}

async function loginAI(id) {
  toast('AI 로그인 브라우저가 열립니다. 로그인 후 창을 닫으세요.', 'info');
  try {
    await api('POST', `/api/posts/login/ai/${id}`);
  } catch (e) { toast(e.message, 'error'); }
}

// ─── 테스트 함수 ─────────────────────────────────────────────────────────────
async function testAIGenerate(aiConfigId) {
  // 이 AI와 연결된 템플릿 선택 가능하도록 프로젝트 템플릿 로드
  const templates = await api('GET', `/api/projects/${currentProjectId}/templates`).catch(() => []);

  let templateId = null;
  if (templates.length > 0) {
    // 템플릿이 있으면 선택 다이얼로그 (간단히 첫번째 또는 confirm으로 선택)
    if (templates.length === 1) {
      templateId = templates[0].id;
    } else {
      const names = templates.map((t, i) => `${i+1}. ${t.name}`).join('\n');
      const idx = prompt(`사용할 템플릿 번호를 입력하세요:\n${names}`);
      if (idx && !isNaN(parseInt(idx))) {
        templateId = templates[parseInt(idx) - 1]?.id || null;
      }
    }
  }

  showTestModal('AI 생성 테스트', `
    <div class="flex-center gap-8" style="padding:24px;justify-content:center">
      <div class="loading"></div>
      <span>AI 브라우저 실행 중... 잠시 기다려주세요 (1~2분 소요)</span>
    </div>
  `);

  try {
    const result = await api('POST', '/api/posts/test/ai-generate', {
      ai_config_id: aiConfigId,
      template_id: templateId,
    });

    showTestModal('AI 생성 테스트 결과', `
      <div style="margin-bottom:12px">
        <span class="badge badge-green">✓ 생성 성공</span>
        <span class="text-muted text-sm" style="margin-left:8px">AI: ${result.ai_name} · ${result.content.length}자</span>
      </div>
      <div style="margin-bottom:8px;font-size:11px;color:var(--text2)">사용한 프롬프트</div>
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;color:var(--text2);white-space:pre-wrap;max-height:100px;overflow-y:auto;margin-bottom:16px">${result.prompt}</div>
      <div style="margin-bottom:8px;font-size:11px;color:var(--text2)">생성된 메인 포스트</div>
      <div class="post-content" style="max-height:300px;overflow-y:auto">${result.content}</div>
      <div style="margin-top:12px;padding:10px;background:#14532d22;border-radius:8px;font-size:12px;color:var(--green)">
        💡 내용이 마음에 들면 스케줄 설정 후 자동 포스팅, 또는 대시보드에서 "오늘 콘텐츠 생성"을 사용하세요.
      </div>
    `);
  } catch (e) {
    showTestModal('AI 생성 테스트 실패', `
      <div class="badge badge-red" style="margin-bottom:12px">✗ 오류 발생</div>
      <div style="background:#450a0a22;border:1px solid var(--red);border-radius:8px;padding:14px;font-size:13px;color:#fca5a5;white-space:pre-wrap">${e.message}</div>
      <div style="margin-top:12px;padding:10px;background:var(--surface2);border-radius:8px;font-size:12px;color:var(--text2)">
        <b>해결 방법:</b><br>
        1. "로그인 설정" 버튼을 클릭해 AI에 다시 로그인하세요.<br>
        2. 커스텀 AI라면 셀렉터 설정을 확인하세요.<br>
        3. AI 사이트가 열려있는 상태인지 확인하세요.
      </div>
    `);
  }
}

async function checkAccountLogin(accountId) {
  showTestModal('Threads 로그인 확인', `
    <div class="flex-center gap-8" style="padding:24px;justify-content:center">
      <div class="loading"></div>
      <span>로그인 상태 확인 중... (headless 브라우저 실행)</span>
    </div>
  `);

  try {
    const result = await api('POST', `/api/posts/test/check-login/${accountId}`);
    const detected = result.detectedUsername;
    const expected = (result.username || '').toLowerCase();
    const mismatch = detected && expected && detected !== expected;

    if (result.isLoggedIn && !mismatch) {
      showTestModal('Threads 로그인 확인', `
        <div style="text-align:center;padding:20px">
          <div style="font-size:36px;margin-bottom:12px">✅</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">로그인 상태 정상</div>
          <div class="text-muted">@${detected || result.username} 계정이 로그인되어 있습니다.</div>
          <div class="text-muted text-sm" style="margin-top:8px">${result.url}</div>
        </div>
      `);
    } else if (result.isLoggedIn && mismatch) {
      showTestModal('Threads 로그인 확인', `
        <div style="text-align:center;padding:20px">
          <div style="font-size:36px;margin-bottom:12px">⚠️</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">다른 계정으로 로그인됨</div>
          <div class="text-muted">현재: <b>@${detected}</b> / 필요: <b>@${result.username}</b></div>
          <div style="margin-top:16px"><button class="btn btn-primary" onclick="closeModal('modal-test');loginAccount(${accountId})">로그인 설정 열기</button></div>
        </div>
      `);
    } else {
      showTestModal('Threads 로그인 확인', `
        <div style="text-align:center;padding:20px">
          <div style="font-size:36px;margin-bottom:12px">❌</div>
          <div style="font-size:16px;font-weight:600;margin-bottom:8px">로그인 필요</div>
          <div class="text-muted">@${result.username} 계정 로그인이 필요합니다.</div>
          <div style="margin-top:16px"><button class="btn btn-primary" onclick="closeModal('modal-test');loginAccount(${accountId})">로그인 설정 열기</button></div>
        </div>
      `);
    }
  } catch (e) {
    showTestModal('로그인 확인 실패', `
      <div class="badge badge-red" style="margin-bottom:12px">오류</div>
      <div style="font-size:13px;color:#fca5a5">${e.message}</div>
    `);
  }
}

function showTestModal(title, bodyHtml) {
  document.getElementById('modal-test-title').textContent = title;
  document.getElementById('modal-test-body').innerHTML = bodyHtml;
  openModal('modal-test');
}

// ─── Templates ────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const templates = await api('GET', `/api/projects/${currentProjectId}/templates`);
  const el = document.getElementById('template-list');
  if (templates.length === 0) {
    el.innerHTML = '<div class="empty" style="padding:24px"><p>템플릿이 없습니다.</p></div>';
    return;
  }
  el.innerHTML = templates.map(t => `
    <div class="card-sm" style="margin-bottom:8px">
      <div class="flex-between">
        <div style="font-weight:500">${t.name}</div>
        <div class="flex gap-8">
          <button class="btn btn-xs btn-secondary" onclick="editTemplate(${t.id})">편집</button>
          <button class="btn btn-xs btn-red" onclick="deleteTemplate(${t.id})">삭제</button>
        </div>
      </div>
      <div class="text-sm text-muted mt-8" style="max-height:40px;overflow:hidden">${t.main_prompt?.substring(0,100) || '(프롬프트 없음)'}</div>
    </div>
  `).join('');
}

function openAddTemplate() {
  editingId = null;
  hashtags = [];
  document.getElementById('tmpl-name').value = '';
  document.getElementById('tmpl-prompt').value = '';
  document.getElementById('tmpl-comment').value = '';
  renderHashtags();
  openModal('modal-template');
}

async function editTemplate(id) {
  const templates = await api('GET', `/api/projects/${currentProjectId}/templates`);
  const t = templates.find(x => x.id === id);
  if (!t) return;
  editingId = id;
  hashtags = JSON.parse(t.hashtags || '[]');
  document.getElementById('tmpl-name').value = t.name || '';
  document.getElementById('tmpl-prompt').value = t.main_prompt || '';
  document.getElementById('tmpl-comment').value = t.comment_template || '';
  renderHashtags();
  openModal('modal-template');
}

async function saveTemplate() {
  const body = {
    name: document.getElementById('tmpl-name').value || '기본 템플릿',
    main_prompt: document.getElementById('tmpl-prompt').value,
    comment_template: document.getElementById('tmpl-comment').value,
    hashtags,
    is_active: 1,
  };

  try {
    if (editingId) {
      await api('PUT', `/api/projects/${currentProjectId}/templates/${editingId}`, body);
    } else {
      await api('POST', `/api/projects/${currentProjectId}/templates`, body);
    }
    toast('저장되었습니다.', 'success');
    closeModal('modal-template');
    loadTemplates();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteTemplate(id) {
  if (!confirm('삭제하시겠습니까?')) return;
  await api('DELETE', `/api/projects/${currentProjectId}/templates/${id}`);
  loadTemplates();
}

function addHashtag(e) {
  if (e.key !== 'Enter') return;
  const input = document.getElementById('tmpl-hashtag-input');
  const tag = input.value.replace('#', '').trim();
  if (tag && !hashtags.includes(tag)) {
    hashtags.push(tag);
    renderHashtags();
  }
  input.value = '';
}

function renderHashtags() {
  const container = document.getElementById('hashtag-list');
  container.innerHTML = hashtags.map(t =>
    `<div class="tag" data-tag="${t}">#${t} <button type="button" class="remove-tag-btn" data-tag="${t}">×</button></div>`
  ).join('');
  container.querySelectorAll('.remove-tag-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      hashtags = hashtags.filter(t => t !== btn.dataset.tag);
      renderHashtags();
    });
  });
}

// ─── Schedules ────────────────────────────────────────────────────────────────
async function loadSchedules() {
  try {
    const projects = await api('GET', '/api/projects');
    const allRules = (await Promise.all(projects.map(p => api('GET', `/api/projects/${p.id}/schedules`)))).flat();

    const el = document.getElementById('schedules-table');
    if (allRules.length === 0) {
      el.innerHTML = '<div class="empty"><div class="empty-icon">🗓️</div><p>스케줄이 없습니다. 추가해보세요.</p></div>';
      return;
    }

    const allAccounts = (await Promise.all(projects.map(p => api('GET', `/api/projects/${p.id}/accounts`)))).flat();
    const allAI = (await Promise.all(projects.map(p => api('GET', `/api/projects/${p.id}/ai-configs`)))).flat();
    const allTemplates = (await Promise.all(projects.map(p => api('GET', `/api/projects/${p.id}/templates`)))).flat();

    // 모달 편집 시 재사용을 위해 캐시
    cachedScheduleData = { projects, allAccounts, allAI, allTemplates };

    el.innerHTML = `<table>
      <thead><tr><th>프로젝트</th><th>계정</th><th>AI</th><th>생성 시간</th><th>포스팅 시간</th><th>요일</th><th>상태</th><th></th></tr></thead>
      <tbody>${allRules.map(r => {
        const proj = projects.find(p => p.id === r.project_id);
        const acc = allAccounts.find(a => a.id === r.account_id);
        const ai = allAI.find(a => a.id === r.ai_config_id);
        const times = JSON.parse(r.post_times || '[]');
        const days = JSON.parse(r.active_days || '[]');
        const dayNames = ['','월','화','수','목','금','토','일'];
        return `<tr>
          <td>${proj?.name || '-'}</td>
          <td>@${acc?.username || '-'}</td>
          <td>${ai?.name || '-'}</td>
          <td>${r.preview_time}</td>
          <td>${times.join(', ')}</td>
          <td>${days.map(d => dayNames[d]).join(' ')}</td>
          <td>${r.is_active ? '<span class="badge badge-green">활성</span>' : '<span class="badge badge-gray">비활성</span>'}</td>
          <td>
            <div class="flex gap-8">
              <button class="btn btn-xs btn-secondary" onclick="editSchedule(${r.project_id},${r.id})">수정</button>
              <button class="btn btn-xs btn-red" onclick="deleteSchedule(${r.project_id},${r.id})">삭제</button>
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  } catch (e) { toast('스케줄 로드 실패: ' + e.message, 'error'); }
}

async function openScheduleModal() {
  editingScheduleId = null;
  editingScheduleProjId = null;
  document.querySelector('#modal-schedule .modal-title').textContent = '스케줄 추가';

  postTimes = ['18:00'];
  document.getElementById('sch-preview-time').value = '09:00';
  document.getElementById('sch-post-time-input').value = '18:00';
  document.getElementById('sch-variance').value = '5';
  renderPostTimes();
  document.getElementById('day-selector').querySelectorAll('.checkbox-day').forEach(el => el.classList.add('selected'));

  try {
    const projects = await api('GET', '/api/projects');
    const sel = document.getElementById('sch-project');
    sel.innerHTML = projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    sel.disabled = false;
    await loadScheduleOptions();
  } catch (e) {}

  openModal('modal-schedule');
}

async function editSchedule(projectId, ruleId) {
  // 캐시가 없으면 먼저 로드
  if (!cachedScheduleData.projects) await loadSchedules();

  const { projects, allAccounts, allAI, allTemplates } = cachedScheduleData;
  const rules = await api('GET', `/api/projects/${projectId}/schedules`);
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) return toast('스케줄 데이터를 찾을 수 없습니다.', 'error');

  editingScheduleId = ruleId;
  editingScheduleProjId = projectId;
  document.querySelector('#modal-schedule .modal-title').textContent = '스케줄 수정';

  // 프로젝트 셀렉터 채우고 선택 (수정 시 프로젝트 변경 불가)
  const projSel = document.getElementById('sch-project');
  projSel.innerHTML = projects.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  projSel.value = projectId;
  projSel.disabled = true; // 수정 시 프로젝트는 변경 불가

  // 해당 프로젝트 옵션 채우기
  const accounts = allAccounts.filter(a => a.project_id === projectId);
  const aiConfigs = allAI.filter(a => a.project_id === projectId);
  const templates = allTemplates.filter(t => t.project_id === projectId);

  document.getElementById('sch-account').innerHTML = accounts.map(a => `<option value="${a.id}">@${a.username}</option>`).join('') || '<option value="">계정 없음</option>';
  document.getElementById('sch-ai').innerHTML = aiConfigs.map(a => `<option value="${a.id}">${a.name}</option>`).join('') || '<option value="">AI 설정 없음</option>';
  document.getElementById('sch-template').innerHTML = templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('') || '<option value="">템플릿 없음</option>';

  // 기존 값 세팅
  document.getElementById('sch-account').value = rule.account_id;
  document.getElementById('sch-ai').value = rule.ai_config_id;
  document.getElementById('sch-template').value = rule.template_id;
  document.getElementById('sch-preview-time').value = rule.preview_time || '09:00';
  document.getElementById('sch-variance').value = rule.timing_variance_min ?? 5;

  postTimes = JSON.parse(rule.post_times || '["18:00"]');
  document.getElementById('sch-post-time-input').value = '';
  renderPostTimes();

  const activeDays = JSON.parse(rule.active_days || '[1,2,3,4,5,6,7]');
  document.getElementById('day-selector').querySelectorAll('.checkbox-day').forEach(el => {
    const day = parseInt(el.dataset.day);
    el.classList.toggle('selected', activeDays.includes(day));
  });

  openModal('modal-schedule');
}

async function loadScheduleOptions() {
  const pid = document.getElementById('sch-project').value;
  if (!pid) return;

  const [accounts, aiConfigs, templates] = await Promise.all([
    api('GET', `/api/projects/${pid}/accounts`),
    api('GET', `/api/projects/${pid}/ai-configs`),
    api('GET', `/api/projects/${pid}/templates`),
  ]);

  document.getElementById('sch-account').innerHTML = accounts.map(a => `<option value="${a.id}">@${a.username}</option>`).join('') || '<option value="">계정 없음</option>';
  document.getElementById('sch-ai').innerHTML = aiConfigs.map(a => `<option value="${a.id}">${a.name}</option>`).join('') || '<option value="">AI 설정 없음</option>';
  document.getElementById('sch-template').innerHTML = templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('') || '<option value="">템플릿 없음</option>';
}

function addPostTime() {
  const input = document.getElementById('sch-post-time-input');
  const time = input.value;
  if (!time) return toast('시간을 선택하세요.', 'error');
  if (postTimes.includes(time)) return toast('이미 추가된 시간입니다.', 'info');
  postTimes.push(time);
  postTimes.sort();
  renderPostTimes();
}

function renderPostTimes() {
  const container = document.getElementById('post-times-list');
  if (postTimes.length === 0) {
    container.innerHTML = '<span class="text-muted text-sm">포스팅 시간을 추가하세요</span>';
    return;
  }
  container.innerHTML = postTimes.map(t =>
    `<div class="time-tag" data-time="${t}">${t} <button type="button" class="remove-time-btn" data-time="${t}">×</button></div>`
  ).join('');
  // 인라인 onclick 대신 이벤트 리스너 직접 부착 (동적 렌더링 안전)
  container.querySelectorAll('.remove-time-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const time = btn.dataset.time;
      postTimes = postTimes.filter(t => t !== time);
      renderPostTimes();
    });
  });
}

function toggleDay(el) {
  el.classList.toggle('selected');
}

async function saveSchedule() {
  const project_id = editingScheduleProjId || document.getElementById('sch-project').value;
  const account_id = document.getElementById('sch-account').value;
  const ai_config_id = document.getElementById('sch-ai').value;
  const template_id = document.getElementById('sch-template').value;
  if (!project_id || !account_id || !ai_config_id || !template_id) return toast('모든 필드를 선택하세요.', 'error');
  if (postTimes.length === 0) return toast('포스팅 시간을 추가하세요.', 'error');

  const active_days = Array.from(document.querySelectorAll('#day-selector .checkbox-day.selected')).map(el => parseInt(el.dataset.day));
  const body = {
    account_id: parseInt(account_id),
    ai_config_id: parseInt(ai_config_id),
    template_id: parseInt(template_id),
    preview_time: document.getElementById('sch-preview-time').value,
    post_times: postTimes,
    active_days,
    timing_variance_min: parseInt(document.getElementById('sch-variance').value) || 5,
    is_active: 1,
  };

  try {
    if (editingScheduleId) {
      await api('PUT', `/api/projects/${project_id}/schedules/${editingScheduleId}`, body);
      toast('스케줄이 수정되었습니다.', 'success');
    } else {
      await api('POST', `/api/projects/${project_id}/schedules`, body);
      toast('스케줄이 추가되었습니다.', 'success');
    }
    // 프로젝트 셀렉터 disabled 해제
    document.getElementById('sch-project').disabled = false;
    closeModal('modal-schedule');
    loadSchedules();
    // 프로젝트 상세의 스케줄 탭이 열려있으면 함께 갱신
    if (document.getElementById('tab-schedules')?.style.display !== 'none') {
      loadProjectSchedules();
    }
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteSchedule(projectId, ruleId) {
  if (!confirm('스케줄을 삭제하시겠습니까?')) return;
  await api('DELETE', `/api/projects/${projectId}/schedules/${ruleId}`);
  toast('삭제되었습니다.', 'success');
  loadSchedules();
}

// ─── Modal helpers ────────────────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('open');
  modalOpenTime = Date.now(); // 열린 시각 기록
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  // 스케줄 모달 닫을 때 프로젝트 셀렉터 disabled 항상 해제
  if (id === 'modal-schedule') {
    document.getElementById('sch-project').disabled = false;
  }
}

// 모달 내부 클릭이 overlay로 버블링되지 않도록 차단
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', e => e.stopPropagation());
});

// 드래그 시작 위치 추적 — 모달 안에서 mousedown이 시작된 경우 overlay click 무시
let mousedownInsideModal = false;
document.addEventListener('mousedown', e => {
  mousedownInsideModal = !!e.target.closest('.modal');
});

// 모달 외부(overlay) 클릭시 닫기
// - 열린 직후 300ms 이내 무시 (이중클릭 방지)
// - 모달 안에서 드래그 후 overlay에서 mouseup한 경우 무시 (텍스트 드래그 선택 보호)
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay && !mousedownInsideModal && Date.now() - modalOpenTime > 300) {
      closeModal(overlay.id);
    }
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
document.getElementById('today-date').textContent = new Date().toLocaleDateString('ko-KR', {
  year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
});

// 마지막 페이지 복원
const savedPage = localStorage.getItem('currentPage');
navigate(savedPage || 'dashboard');

// 30초마다 대시보드 자동 새로고침
setInterval(() => {
  if (currentPage === 'dashboard') loadDashboard();
}, 30000);

// ─── Project Schedule Connection Tab ──────────────────────────────────────────
async function loadProjectSchedules() {
  if (!currentProjectId) return;
  const el = document.getElementById('project-schedules-list');
  el.innerHTML = '<div class="text-muted text-sm" style="padding:12px">로드 중...</div>';
  try {
    const [rules, accounts, aiConfigs, templates] = await Promise.all([
      api('GET', `/api/projects/${currentProjectId}/schedules`),
      api('GET', `/api/projects/${currentProjectId}/accounts`),
      api('GET', `/api/projects/${currentProjectId}/ai-configs`),
      api('GET', `/api/projects/${currentProjectId}/templates`),
    ]);

    if (rules.length === 0) {
      el.innerHTML = `
        <div class="empty" style="padding:24px">
          <p>아직 연결된 스케줄이 없습니다.</p>
          <p class="text-sm" style="margin-top:8px">계정 · AI · 템플릿을 각각 추가한 뒤 스케줄로 연결하세요.</p>
        </div>`;
      return;
    }

    const dayNames = ['','월','화','수','목','금','토','일'];
    el.innerHTML = rules.map(r => {
      const acc = accounts.find(a => a.id === r.account_id);
      const ai = aiConfigs.find(a => a.id === r.ai_config_id);
      const tmpl = templates.find(t => t.id === r.template_id);
      const times = JSON.parse(r.post_times || '[]');
      const days = JSON.parse(r.active_days || '[]');
      return `
        <div class="card-sm" style="margin-bottom:8px">
          <div class="flex-between">
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
                <span style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-size:12px;color:var(--accent2)">@${escHtml(acc?.username || '?')}</span>
                <span style="color:var(--text2);font-size:13px">→</span>
                <span style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-size:12px">${escHtml(ai?.name || '?')}</span>
                <span style="color:var(--text2);font-size:13px">→</span>
                <span style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-size:12px">${escHtml(tmpl?.name || '?')}</span>
              </div>
              <div class="text-sm text-muted">
                생성 ${r.preview_time} · 포스팅 ${times.join(', ')} · ${days.map(d => dayNames[d]).join(' ')}
                · ${r.is_active ? '<span style="color:var(--green)">● 활성</span>' : '<span style="color:var(--text2)">○ 비활성</span>'}
              </div>
            </div>
            <div class="flex gap-8" style="margin-left:12px;flex-shrink:0">
              <button class="btn btn-xs btn-secondary" onclick="editSchedule(${r.project_id},${r.id})">수정</button>
              <button class="btn btn-xs btn-red" onclick="deleteProjectSchedule(${r.project_id},${r.id})">삭제</button>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (e) { el.innerHTML = `<div class="text-muted text-sm" style="padding:12px">로드 실패: ${e.message}</div>`; }
}

async function openScheduleFromProject() {
  const projId = currentProjectId;
  editingScheduleId = null;
  editingScheduleProjId = null;
  document.querySelector('#modal-schedule .modal-title').textContent = '스케줄 추가';
  postTimes = ['18:00'];
  document.getElementById('sch-preview-time').value = '09:00';
  document.getElementById('sch-post-time-input').value = '18:00';
  document.getElementById('sch-variance').value = '5';
  renderPostTimes();
  document.getElementById('day-selector').querySelectorAll('.checkbox-day').forEach(el => el.classList.add('selected'));
  try {
    const projects = await api('GET', '/api/projects');
    const sel = document.getElementById('sch-project');
    sel.innerHTML = projects.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    sel.value = projId;
    sel.disabled = true; // 현재 프로젝트 고정
    await loadScheduleOptions();
  } catch (e) {}
  openModal('modal-schedule');
}

async function deleteProjectSchedule(projectId, ruleId) {
  if (!confirm('스케줄을 삭제하시겠습니까?')) return;
  await api('DELETE', `/api/projects/${projectId}/schedules/${ruleId}`);
  toast('삭제되었습니다.', 'success');
  loadProjectSchedules();
}

// ─── Benchmarking Tab (per-project) ───────────────────────────────────────────

let bmTabTargets = []; // in-memory target list while editing

async function loadBmTab() {
  if (!currentProjectId) return;
  try {
    const [bmRes, accountsRes, aiRes] = await Promise.all([
      api('GET', `/api/projects/${currentProjectId}/benchmarking`),
      api('GET', `/api/projects/${currentProjectId}/accounts`),
      api('GET', `/api/projects/${currentProjectId}/ai-configs`),
    ]);

    const cfg = bmRes.data || {};

    // Populate posting account dropdown
    const accSel = document.getElementById('bm-posting-account');
    accSel.innerHTML = '<option value="">— 선택 —</option>' +
      accountsRes.map(a => `<option value="${a.id}">@${escHtml(a.username)}</option>`).join('');
    accSel.value = cfg.posting_account_id || '';

    // Populate AI config dropdown
    const aiSel = document.getElementById('bm-ai-config');
    aiSel.innerHTML = '<option value="">— AI 없음 (원본 그대로) —</option>' +
      aiRes.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
    aiSel.value = cfg.ai_config_id || '';

    // Fill form
    document.getElementById('bm-enabled').checked = !!cfg.is_enabled;
    document.getElementById('bm-interval-hours').value = cfg.interval_hours || 6;
    document.getElementById('bm-posts-per-run').value = cfg.posts_per_run || 1;
    document.getElementById('bm-rewrite-prompt').value = cfg.rewrite_prompt || '';

    bmTabTargets = JSON.parse(cfg.targets || '[]');
    renderBmTargets();
  } catch (e) {
    toast('벤치마킹 설정 로드 실패: ' + e.message, 'error');
  }
}

function renderBmTargets() {
  const container = document.getElementById('bm-targets-list');
  if (!bmTabTargets.length) {
    container.innerHTML = '<p class="text-muted text-sm">추가된 대상 계정이 없습니다.</p>';
    return;
  }
  container.innerHTML = bmTabTargets.map((t, i) => `
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
      <div style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end">
        <div class="form-group" style="margin:0">
          <label class="form-label">Threads URL</label>
          <input class="form-input" id="bmt-url-${i}" value="${escHtml(t.url)}" placeholder="https://www.threads.net/@username">
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);white-space:nowrap">
            <input type="checkbox" id="bmt-enabled-${i}" ${t.enabled !== false ? 'checked' : ''}> 활성
          </label>
          <button class="btn btn-xs btn-red" onclick="removeBmTarget(${i})">삭제</button>
        </div>
      </div>
    </div>
  `).join('');
}

function addBmTarget() {
  const rows = document.querySelectorAll('[id^="bmt-url-"]');
  rows.forEach((_, i) => {
    if (i < bmTabTargets.length) {
      bmTabTargets[i].url = document.getElementById(`bmt-url-${i}`)?.value || '';
      bmTabTargets[i].enabled = !!(document.getElementById(`bmt-enabled-${i}`)?.checked);
    }
  });
  bmTabTargets.push({ url: '', enabled: true });
  renderBmTargets();
}

function removeBmTarget(index) {
  const rows = document.querySelectorAll('[id^="bmt-url-"]');
  rows.forEach((_, i) => {
    if (i < bmTabTargets.length) {
      bmTabTargets[i].url = document.getElementById(`bmt-url-${i}`)?.value || '';
      bmTabTargets[i].enabled = !!(document.getElementById(`bmt-enabled-${i}`)?.checked);
    }
  });
  bmTabTargets.splice(index, 1);
  renderBmTargets();
}

function readBmTargetsFromForm() {
  const rows = document.querySelectorAll('[id^="bmt-url-"]');
  const result = [];
  rows.forEach((_, i) => {
    result.push({
      url: (document.getElementById(`bmt-url-${i}`)?.value || '').trim(),
      enabled: !!(document.getElementById(`bmt-enabled-${i}`)?.checked),
    });
  });
  return result;
}

async function saveBmConfig() {
  if (!currentProjectId) return;
  try {
    await api('PUT', `/api/projects/${currentProjectId}/benchmarking`, {
      is_enabled: document.getElementById('bm-enabled').checked,
      interval_hours: parseInt(document.getElementById('bm-interval-hours').value) || 6,
      posts_per_run: parseInt(document.getElementById('bm-posts-per-run').value) || 1,
      posting_account_id: document.getElementById('bm-posting-account').value || null,
      ai_config_id: document.getElementById('bm-ai-config').value || null,
      rewrite_prompt: document.getElementById('bm-rewrite-prompt').value,
      targets: readBmTargetsFromForm(),
    });
    toast('벤치마킹 설정 저장됨', 'success');
  } catch (e) { toast('저장 실패: ' + e.message, 'error'); }
}

async function runBmForProject() {
  if (!currentProjectId) return;
  const btn = document.getElementById('bm-run-btn');
  btn.disabled = true;
  btn.textContent = '실행 중...';
  try {
    const res = await api('POST', `/api/projects/${currentProjectId}/benchmarking/run`);
    toast(res.message || '벤치마킹 시작됨', res.success ? 'success' : 'info');
  } catch (e) {
    toast('실행 오류: ' + e.message, 'error');
  } finally {
    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '▶ 지금 실행'; } }, 3000);
  }
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Quick Add Post ────────────────────────────────────────────────────────────
async function openQuickAddModal() {
  // Default scheduled time: 1 hour from now
  const d = new Date(Date.now() + 3600000);
  const pad = n => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  document.getElementById('qa-scheduled-time').value = local;

  // Reset dependent selects
  ['qa-account', 'qa-ai-config', 'qa-template'].forEach(id => {
    const el = document.getElementById(id);
    el.innerHTML = '<option value="">— 먼저 프로젝트 선택 —</option>';
    el.disabled = true;
  });

  // Load projects
  try {
    const projects = await api('GET', '/api/projects');
    const sel = document.getElementById('qa-project');
    sel.innerHTML = '<option value="">— 프로젝트 선택 —</option>' +
      projects.map(p => `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    sel.value = '';
  } catch (e) {
    toast('프로젝트 로드 실패: ' + e.message, 'error');
    return;
  }

  openModal('modal-quick-add');
}

async function onQuickAddProjectChange() {
  const pid = document.getElementById('qa-project').value;
  qaBmConfig = null;

  if (!pid) {
    ['qa-account', 'qa-ai-config', 'qa-template'].forEach(id => {
      const el = document.getElementById(id);
      el.innerHTML = '<option value="">— 먼저 프로젝트 선택 —</option>';
      el.disabled = true;
    });
    document.getElementById('qa-bm-notice').style.display = 'none';
    document.getElementById('qa-normal-fields').style.display = 'block';
    const btn = document.getElementById('qa-save-btn');
    btn.textContent = '포스트 생성';
    btn.onclick = saveQuickAdd;
    return;
  }

  try {
    const [accounts, aiConfigs, templates, bmResp] = await Promise.all([
      api('GET', `/api/projects/${pid}/accounts`),
      api('GET', `/api/projects/${pid}/ai-configs`),
      api('GET', `/api/projects/${pid}/templates`),
      api('GET', `/api/projects/${pid}/benchmarking`).catch(() => ({ data: null })),
    ]);

    qaBmConfig = bmResp.data || null;

    const acSel = document.getElementById('qa-account');
    acSel.innerHTML = '<option value="">— 계정 선택 —</option>' +
      accounts.map(a => `<option value="${a.id}">@${escHtml(a.username)}</option>`).join('');
    acSel.disabled = false;
    if (accounts.length === 1) acSel.value = accounts[0].id;

    const aiSel = document.getElementById('qa-ai-config');
    aiSel.innerHTML = '<option value="">— AI 설정 선택 —</option>' +
      aiConfigs.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
    aiSel.disabled = false;
    if (aiConfigs.length === 1) aiSel.value = aiConfigs[0].id;

    const tmSel = document.getElementById('qa-template');
    tmSel.innerHTML = '<option value="">— 템플릿 선택 —</option>' +
      templates.map(t => `<option value="${t.id}">${escHtml(t.name)}</option>`).join('');
    tmSel.disabled = false;
    if (templates.length === 1) tmSel.value = templates[0].id;

    // 계정 선택 변경 → 벤치마킹 모드 감지
    onQuickAddAccountChange();
  } catch (e) {
    toast('설정 로드 실패: ' + e.message, 'error');
  }
}

async function onQuickAddAccountChange() {
  const pid = document.getElementById('qa-project').value;
  const accId = document.getElementById('qa-account').value;
  const bmNotice = document.getElementById('qa-bm-notice');
  const normalFields = document.getElementById('qa-normal-fields');
  const saveBtn = document.getElementById('qa-save-btn');

  const isBm = qaBmConfig && accId && Number(accId) === Number(qaBmConfig.posting_account_id);

  if (isBm) {
    bmNotice.style.display = 'block';
    normalFields.style.display = 'none';
    saveBtn.textContent = '▶ 벤치마킹 스크랩 시작';
    saveBtn.onclick = () => saveQuickAddBm(Number(pid));

    // 대기 중인 벤치마킹 포스트 수 표시
    try {
      const posts = await api('GET', '/api/posts/preview');
      const pending = posts.filter(p => p.project_id === Number(pid) && p.source_type === 'benchmarking');
      const info = document.getElementById('qa-bm-pending-info');
      if (info) {
        info.textContent = pending.length > 0
          ? `⚠ 현재 미리보기 대기 중인 벤치마킹 포스트 ${pending.length}개 있음 → 미리보기에서 확인하거나 새로 스크랩하세요.`
          : '아직 스크랩된 포스트가 없습니다. 스크랩을 시작하세요.';
      }
    } catch { /* silent */ }
  } else {
    bmNotice.style.display = 'none';
    normalFields.style.display = 'block';
    saveBtn.textContent = '포스트 생성';
    saveBtn.onclick = saveQuickAdd;
  }
}

async function saveQuickAddBm(projectId) {
  const btn = document.getElementById('qa-save-btn');
  btn.disabled = true;
  btn.textContent = '⏳ 시작 중...';
  try {
    const result = await api('POST', `/api/projects/${projectId}/benchmarking/run`);
    if (!result.success) {
      toast(result.message || '이미 실행 중입니다.', 'info');
    }
    // 성공/중복 모두 → 모달을 진행 현황 뷰로 전환
    showBmProgressView(projectId);
  } catch (e) {
    toast('실행 실패: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = '▶ 벤치마킹 스크랩 시작';
  }
}

let bmProgressTimer = null;
let bmProgressLastLen = 0;

function showBmProgressView(projectId) {
  if (!document.getElementById('bm-progress-style')) {
    const s = document.createElement('style');
    s.id = 'bm-progress-style';
    s.textContent = `
      @keyframes bm-slide { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
      .bm-bar-running { background:linear-gradient(90deg,#7c3aed,#9d5cf5,#7c3aed);background-size:200% 100%;animation:bm-slide 1.8s linear infinite; }
    `;
    document.head.appendChild(s);
  }

  const modal = document.querySelector('#modal-quick-add .modal');
  modal.innerHTML = `
    <div class="modal-header">
      <div class="modal-title">🔍 벤치마킹 스크랩 진행 중</div>
    </div>
    <div style="padding:4px 0 16px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text2);margin-bottom:6px">
        <span id="bm-prog-label">준비 중...</span>
        <span id="bm-prog-count" style="color:var(--accent2)"></span>
      </div>
      <div style="background:var(--surface2);border-radius:6px;height:8px;overflow:hidden;margin-bottom:16px">
        <div id="bm-prog-bar" class="bm-bar-running" style="height:100%;width:5%;transition:width .4s"></div>
      </div>
      <div id="bm-prog-log" style="background:var(--surface2);border-radius:8px;padding:10px;height:200px;overflow-y:auto;font-size:12px;font-family:monospace;display:flex;flex-direction:column;gap:2px">
        <span style="color:var(--text2)">스크랩 시작됨 — 로그 수신 대기 중...</span>
      </div>
    </div>
    <div class="modal-footer" id="bm-prog-footer">
      <span style="font-size:12px;color:var(--text2)">브라우저가 자동으로 열립니다. 창을 닫지 마세요.</span>
    </div>
  `;

  bmProgressLastLen = 0;
  if (bmProgressTimer) clearInterval(bmProgressTimer);
  bmProgressTimer = setInterval(() => pollBmProgress(projectId), 1500);
  pollBmProgress(projectId);

  if (!activeTasksTimer) activeTasksTimer = setInterval(loadActiveTasks, 5000);
}

async function pollBmProgress(_projectId) {
  try {
    const data = await api('GET', '/api/benchmarking/progress');

    const bar    = document.getElementById('bm-prog-bar');
    const label  = document.getElementById('bm-prog-label');
    const countEl = document.getElementById('bm-prog-count');
    const logEl  = document.getElementById('bm-prog-log');
    const footer = document.getElementById('bm-prog-footer');
    if (!bar || !logEl) {
      if (bmProgressTimer) { clearInterval(bmProgressTimer); bmProgressTimer = null; }
      return;
    }

    // 새 로그 항목 추가
    const newEntries = data.log.slice(bmProgressLastLen);
    if (bmProgressLastLen === 0 && data.log.length > 0) logEl.innerHTML = '';
    bmProgressLastLen = data.log.length;

    newEntries.forEach(entry => {
      const div = document.createElement('div');
      div.style.cssText = `padding:2px 0;border-bottom:1px solid #1e1e1e;${
        entry.type === 'done'  ? 'color:var(--green);font-weight:600' :
        entry.type === 'error' ? 'color:#fca5a5' : 'color:var(--text2)'
      }`;
      div.textContent = entry.msg;
      logEl.appendChild(div);
    });
    if (newEntries.length > 0) logEl.scrollTop = logEl.scrollHeight;

    // 진행 바
    const total = data.total || 1;
    const done  = data.done  || 0;
    const pct = data.running ? Math.max(5, Math.min(88, (done / total) * 100)) : 100;
    bar.style.width = pct + '%';

    if (data.running) {
      const last = data.log[data.log.length - 1];
      if (label) label.textContent = last ? last.msg.replace(/^\s+↳\s*/, '') : '진행 중...';
      if (countEl && total > 1) countEl.textContent = `${done} / ${total}`;
    } else {
      // 완료
      bar.className = '';
      bar.style.cssText = 'height:100%;width:100%;background:var(--green);transition:width .4s';
      if (label)  label.textContent  = '✅ 스크랩 완료!';
      if (countEl) countEl.textContent = `${done}개 처리됨`;
      if (footer) {
        footer.innerHTML = `
          <button class="btn btn-secondary" onclick="closeModal('modal-quick-add')">닫기</button>
          <button class="btn btn-primary" onclick="closeModal('modal-quick-add');navigate('preview');setPreviewFilter('benchmarking')">미리보기 확인 →</button>
        `;
      }
      if (bmProgressTimer) { clearInterval(bmProgressTimer); bmProgressTimer = null; }
      loadBenchmarkingOverview();
    }
  } catch { /* silent */ }
}

async function saveQuickAdd() {
  const project_id = document.getElementById('qa-project').value;
  const account_id = document.getElementById('qa-account').value;
  const ai_config_id = document.getElementById('qa-ai-config').value;
  const template_id = document.getElementById('qa-template').value;
  const scheduled_time = document.getElementById('qa-scheduled-time').value;

  if (!project_id || !account_id || !ai_config_id || !template_id || !scheduled_time) {
    toast('모든 필드를 입력해주세요.', 'error');
    return;
  }

  const btn = document.getElementById('qa-save-btn');
  btn.disabled = true;
  btn.textContent = '생성 중...';

  try {
    const { id } = await api('POST', '/api/posts/create', {
      project_id: Number(project_id),
      account_id: Number(account_id),
      ai_config_id: Number(ai_config_id),
      template_id: Number(template_id),
      scheduled_time: new Date(scheduled_time).toISOString(),
    });

    closeModal('modal-quick-add');
    toast('포스트 생성됨. AI 콘텐츠 생성 중...', 'info');

    try {
      await api('POST', `/api/posts/${id}/regenerate`);
      toast('콘텐츠 생성 완료! 미리보기에서 확인하세요.', 'success');
    } catch (e) {
      toast('포스트 생성됨, AI 생성 실패: ' + e.message, 'error');
    }

    if (currentPage === 'preview') loadPreview();
    else loadDashboard();
  } catch (e) {
    toast('포스트 생성 실패: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '포스트 생성';
  }
}

// ─── Benchmarking Overview ─────────────────────────────────────────────────────
function bmRelTime(sqliteOrIso) {
  try {
    const str = sqliteOrIso.includes('T') ? sqliteOrIso : sqliteOrIso.replace(' ', 'T') + 'Z';
    const dt = new Date(str);
    const diff = Date.now() - dt.getTime();
    const abs = Math.abs(diff);
    const label = diff > 0 ? '전' : '후';
    if (abs < 60000) return '방금';
    if (abs < 3600000) return `${Math.floor(abs / 60000)}분 ${label}`;
    const h = Math.floor(abs / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    return `${h}시간${m > 0 ? ' ' + m + '분' : ''} ${label}`;
  } catch { return '-'; }
}

async function loadBenchmarkingOverview() {
  try {
    const data = await api('GET', '/api/benchmarking/overview');
    const card = document.getElementById('bm-overview-card');
    const list = document.getElementById('bm-overview-list');
    if (!card || !list) return;

    if (!data.projects || data.projects.length === 0) {
      card.style.display = 'none';
      return;
    }

    card.style.display = 'block';

    const runAllBtn = document.getElementById('bm-run-all-btn');
    const stopOverviewBtn = document.getElementById('bm-stop-overview-btn');
    if (runAllBtn) {
      runAllBtn.disabled = data.running;
      runAllBtn.textContent = data.running ? '⏳ 실행 중...' : '▶ 전체 스크랩';
    }
    if (stopOverviewBtn) stopOverviewBtn.style.display = data.running ? 'inline-flex' : 'none';

    list.innerHTML = data.projects.map(proj => {
      const targets = JSON.parse(proj.targets || '[]');
      const enabledTargets = targets.filter(t => t.enabled && t.url && t.url.trim()).length;
      const isEnabled = proj.is_enabled === 1;

      const lastChecked = proj.last_checked_at ? bmRelTime(proj.last_checked_at) : '아직 실행 안됨';

      let nextCheck = '-';
      if (proj.last_checked_at && isEnabled) {
        const lastMs = new Date(proj.last_checked_at.replace(' ', 'T') + 'Z').getTime();
        const nextMs = lastMs + proj.interval_hours * 3600000;
        nextCheck = nextMs > Date.now() ? bmRelTime(new Date(nextMs).toISOString()) : '곧 실행';
      } else if (!isEnabled) {
        nextCheck = '자동실행 꺼짐';
      }

      const inPreview = proj.in_preview || 0;
      const approved = proj.approved || 0;
      const postedToday = proj.posted_today || 0;
      const postedTotal = proj.posted_total || 0;

      const totalScraped = inPreview + approved + postedTotal;
      return `
        <div style="padding:12px 14px;background:var(--surface2);border-radius:8px;margin-bottom:8px;border:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
            <span style="font-weight:600;font-size:13px">${escHtml(proj.project_name)}</span>
            ${isEnabled ? '' : '<span style="font-size:10px;background:#333;color:var(--text2);padding:2px 6px;border-radius:4px">자동실행 꺼짐</span>'}
            ${proj.posting_account ? `<span style="font-size:11px;color:var(--accent2)">→ @${escHtml(proj.posting_account)}</span>` : '<span style="font-size:11px;color:var(--red)">⚠ 포스팅 계정 미설정</span>'}
            <span style="font-size:11px;color:var(--text2)">대상 ${enabledTargets}개</span>
            <div style="display:flex;gap:6px;margin-left:auto">
              ${totalScraped > 0 ? `<button class="btn btn-xs btn-secondary" onclick="toggleBmProjectDetail(${proj.project_id}, this)">≡ 내역 (${totalScraped})</button>` : ''}
              <button class="btn btn-xs btn-secondary" onclick="triggerBenchmarkingProject(${proj.project_id})" ${data.running ? 'disabled' : ''}>▶ 스크랩</button>
            </div>
          </div>
          <div style="font-size:11px;color:var(--text2);margin-bottom:8px">
            마지막: <strong style="color:var(--text)">${lastChecked}</strong>
            &nbsp;|&nbsp;
            다음: <strong style="color:var(--text)">${nextCheck}</strong>
            ${isEnabled ? `&nbsp;(${proj.interval_hours}시간 주기)` : ''}
          </div>
          <div style="display:flex;gap:16px;font-size:12px;flex-wrap:wrap">
            <span>미리보기 대기: <strong style="color:${inPreview > 0 ? 'var(--yellow)' : 'var(--text)'}">${inPreview}</strong></span>
            <span>승인됨: <strong style="color:var(--blue)">${approved}</strong></span>
            <span>오늘 게시: <strong style="color:var(--green)">${postedToday}</strong></span>
            <span style="color:var(--text2)">누적 게시: ${postedTotal}</span>
            ${inPreview > 0 ? `<a href="#" onclick="navigate('preview');setPreviewFilter('benchmarking');return false;" style="font-size:11px;color:var(--accent2);margin-left:auto">→ 미리보기 확인</a>` : ''}
          </div>
          <!-- 스크랩 내역 (접힘) -->
          <div id="bm-detail-${proj.project_id}" style="display:none;margin-top:10px;border-top:1px solid var(--border);padding-top:10px"></div>
        </div>`;
    }).join('');
  } catch (e) {
    console.error('벤치마킹 현황 로드 실패:', e.message);
  }
}

async function stopBenchmarking() {
  try {
    const result = await api('POST', '/api/benchmarking/stop');
    toast(result.message || '정지 요청됨', result.success ? 'info' : 'error');
    setTimeout(loadBenchmarkingOverview, 800);
  } catch (e) {
    toast('정지 실패: ' + e.message, 'error');
  }
}

async function triggerBenchmarkingAll() {
  const btn = document.getElementById('bm-run-all-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 실행 중...'; }
  try {
    const result = await api('POST', '/api/benchmarking/run');
    if (result.success) {
      toast('전체 벤치마킹 스크랩 시작! 브라우저가 열립니다.', 'info');
      setTimeout(loadBenchmarkingOverview, 1000);
    } else {
      toast(result.message || '이미 실행 중입니다.', 'info');
    }
  } catch (e) {
    toast('스크랩 실행 실패: ' + e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '▶ 전체 스크랩'; }
  }
}

async function triggerBenchmarkingProject(projectId) {
  try {
    const result = await api('POST', `/api/benchmarking/run/${projectId}`);
    if (result.success) {
      toast('벤치마킹 스크랩 시작! 브라우저가 열립니다.', 'info');
      setTimeout(loadBenchmarkingOverview, 1000);
    } else {
      toast(result.message || '이미 실행 중입니다.', 'info');
    }
  } catch (e) {
    toast('스크랩 실행 실패: ' + e.message, 'error');
  }
}

async function toggleBmProjectDetail(projectId, btn) {
  const detail = document.getElementById(`bm-detail-${projectId}`);
  if (!detail) return;

  if (detail.style.display !== 'none') {
    detail.style.display = 'none';
    if (btn) btn.textContent = btn.textContent.replace('▲ ', '≡ ');
    return;
  }

  detail.style.display = 'block';
  if (btn) btn.textContent = btn.textContent.replace('≡ ', '▲ ');
  detail.innerHTML = '<div style="color:var(--text2);font-size:12px;padding:4px 0">로딩 중...</div>';

  try {
    const posts = await api('GET', `/api/posts/benchmarking/${projectId}`);
    if (posts.length === 0) {
      detail.innerHTML = '<div style="color:var(--text2);font-size:12px;padding:4px 0">스크랩된 포스트가 없습니다.</div>';
      return;
    }

    const statusColor = { generated: 'var(--yellow)', approved: 'var(--blue)', posted: 'var(--green)', failed: 'var(--red)', skipped: 'var(--text2)' };

    detail.innerHTML = `
      <div style="font-size:11px;color:var(--text2);margin-bottom:8px">스크랩 내역 (최근 ${posts.length}개)</div>
      ${posts.map(p => {
        const preview = (p.generated_content || p.original_content || '').slice(0, 90);
        const color = statusColor[p.status] || 'var(--text2)';
        const dateStr = p.created_at ? new Date(p.created_at.replace(' ','T')+'Z').toLocaleDateString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
        return `
          <div style="padding:7px 0;border-bottom:1px solid #2a2a2a;display:flex;flex-direction:column;gap:4px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="font-size:11px;color:${color};font-weight:600">${p.status}</span>
              <span style="font-size:11px;color:var(--text2)">${escHtml(dateStr)}</span>
              ${p.source_url ? `<a href="${escHtml(p.source_url)}" target="_blank" style="font-size:10px;color:var(--accent2);margin-left:auto">원본 →</a>` : ''}
            </div>
            <div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(preview)}${preview.length >= 90 ? '...' : ''}</div>
          </div>`;
      }).join('')}
    `;
  } catch (e) {
    detail.innerHTML = `<div style="color:var(--red);font-size:12px;padding:4px 0">로드 실패: ${escHtml(e.message)}</div>`;
  }
}

// ─── 스크랩 데이터 ─────────────────────────────────────────────────────────────
let scrapesData = [];

async function loadScrapes() {
  const projectSel = document.getElementById('scrapes-filter-project');
  const accountSel = document.getElementById('scrapes-filter-account');
  const params = new URLSearchParams();
  if (projectSel?.value) params.set('project_id', projectSel.value);
  if (accountSel?.value) params.set('account_id', accountSel.value);

  try {
    // 필터 옵션 채우기 (첫 로드 시)
    if (projectSel && projectSel.options.length <= 1) {
      const projects = await api('GET', '/api/projects');
      projects.forEach(p => {
        const o = document.createElement('option');
        o.value = p.id; o.textContent = p.name;
        projectSel.appendChild(o);
      });
    }

    const [scrapes, settings, bmOverview] = await Promise.all([
      api('GET', `/api/scrapes?${params}`),
      api('GET', '/api/scrapes/settings/all').catch(() => ({})),
      api('GET', '/api/benchmarking/overview').catch(e => { console.warn('benchmarking/overview 실패:', e); return { projects: [] }; }),
    ]);
    scrapesData = scrapes;

    // "구글시트 보러가기" 버튼 표시 여부
    const openSheetBtn = document.getElementById('open-sheet-btn');
    if (openSheetBtn) openSheetBtn.style.display = settings.sheets_view_url ? 'inline-flex' : 'none';

    // 계정 필터 동적 구성
    if (accountSel && accountSel.options.length <= 1) {
      const seen = new Set();
      scrapes.forEach(s => {
        if (s.username && !seen.has(s.account_id)) {
          seen.add(s.account_id);
          const o = document.createElement('option');
          o.value = s.account_id; o.textContent = '@' + s.username;
          accountSel.appendChild(o);
        }
      });
    }

    // 계정별 수동 스크랩 패널 렌더링
    renderScrapeTargetsPanel(bmOverview.projects || []);

    renderScrapes(scrapes);

    // 배지 업데이트
    const badge = document.getElementById('scrapes-badge');
    if (badge) {
      badge.style.display = scrapes.length > 0 ? 'inline' : 'none';
      badge.textContent = scrapes.length;
    }
  } catch (e) {
    toast('스크랩 데이터 로드 실패: ' + e.message, 'error');
  }
}

// 계정별 수동 스크랩 패널 렌더링
function renderScrapeTargetsPanel(projects) {
  const panel = document.getElementById('scrape-targets-panel');
  const list = document.getElementById('scrape-targets-list');
  if (!panel || !list) return;

  // 활성화된 벤치마킹 프로젝트의 타겟 목록 수집
  const items = [];
  for (const proj of projects) {
    // is_enabled 무관 — 타겟이 있으면 수동 스크랩 버튼 표시
    const targets = JSON.parse(proj.targets || '[]');
    for (const t of targets) {
      if (t.enabled === false || !t.url.trim()) continue;  // undefined → 활성(구형 데이터 호환)
      const m = t.url.match(/@([a-zA-Z0-9_.]+)/);
      const username = m ? m[1] : t.url;
      items.push({ projectId: proj.project_id, projectName: proj.project_name || '', targetUrl: t.url, username, isAutoEnabled: !!proj.is_enabled });
    }
  }

  if (items.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';
  list.innerHTML = items.map(item => `
    <div style="display:flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:6px 10px">
      <span style="font-size:12px;color:var(--text);font-weight:500">@${escHtml(item.username)}</span>
      <span style="font-size:11px;color:var(--text2)">${escHtml(item.projectName)}</span>
      ${!item.isAutoEnabled ? '<span style="font-size:10px;color:var(--yellow);border:1px solid var(--yellow);border-radius:4px;padding:1px 5px">수동</span>' : ''}
      <button class="btn btn-xs btn-primary" id="scrape-btn-${escHtml(item.projectId + '-' + item.username)}"
        onclick="triggerTargetScrape(${item.projectId}, '${escHtml(item.targetUrl)}', '${escHtml(item.username)}')"
        style="margin-left:4px">
        ▶ 스크랩
      </button>
    </div>`).join('');
}

// 특정 대상 계정 수동 스크랩 실행
async function triggerTargetScrape(projectId, targetUrl, username) {
  const btnId = `scrape-btn-${projectId}-${username}`;
  const btn = document.getElementById(btnId);
  try {
    if (btn) { btn.disabled = true; btn.textContent = '실행 중...'; }
    const result = await api('POST', '/api/benchmarking/run-target', { projectId, targetUrl });
    if (result.success) {
      toast(`@${username} 스크랩 시작됨. 진행 상황은 벤치마킹 탭에서 확인하세요.`, 'success');
    } else {
      toast(result.message || '이미 실행 중입니다.', 'info');
    }
  } catch (e) {
    toast('스크랩 실행 실패: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ 스크랩'; }
  }
}

function renderScrapes(scrapes) {
  const tbody = document.getElementById('scrapes-tbody');
  const countEl = document.getElementById('scrapes-count');
  if (!tbody) return;

  if (countEl) countEl.textContent = `총 ${scrapes.length}개`;

  if (scrapes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:40px;text-align:center;color:var(--text2)">
      스크랩 데이터가 없습니다.<br><span style="font-size:12px">벤치마킹 스크랩을 실행하면 데이터가 여기에 쌓입니다.</span>
    </td></tr>`;
    return;
  }

  const rows = scrapes.map((s, i) => {
    const localPaths = JSON.parse(s.media_local_paths || '[]');
    const remotePaths = JSON.parse(s.media_urls || '[]');
    const displayPaths = localPaths.length > 0 ? localPaths : [];
    const totalCount = remotePaths.length;
    const mediaCell = displayPaths.length > 0
      ? `<div style="display:flex;gap:4px;flex-wrap:wrap">${displayPaths.slice(0,3).map(p => {
          const isVideo = /\.(mp4|mov|webm)$/i.test(p);
          const src = p.startsWith('/') ? p : '/' + p;
          return isVideo
            ? `<div style="width:40px;height:40px;background:var(--surface2);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:16px">▶</div>`
            : `<img src="${escHtml(src)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;cursor:pointer" onclick="window.open('${escHtml(src)}','_blank')" onerror="this.style.display='none'">`;
        }).join('')}${totalCount > 3 ? `<span style="font-size:10px;color:var(--text2);align-self:center">+${totalCount-3}</span>` : ''}</div>`
      : (totalCount > 0
          ? `<span style="background:var(--surface2);border-radius:4px;padding:2px 6px;font-size:11px">${totalCount}개</span>`
          : '<span style="color:var(--text2);font-size:11px">없음</span>');

    const textPreview = (s.text_content || '').slice(0, 80) + ((s.text_content || '').length > 80 ? '...' : '');
    const commentPreview = (s.first_comment || '').slice(0, 60) + ((s.first_comment || '').length > 60 ? '...' : '');

    const dt = s.scraped_at ? new Date(s.scraped_at.includes('T') ? s.scraped_at : s.scraped_at.replace(' ', 'T') + 'Z') : null;
    const dateStr = dt ? dt.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';

    const rowBg = i % 2 === 0 ? '' : 'background:var(--surface2)';
    return `<tr style="${rowBg}">
      <td style="padding:8px 12px;color:var(--text2);font-size:11px">${s.id}</td>
      <td style="padding:8px 12px;white-space:nowrap;font-size:11px">${dateStr}</td>
      <td style="padding:8px 12px;white-space:nowrap">
        <span style="font-size:12px">@${escHtml(s.username || '-')}</span>
        ${s.project_name ? `<br><span style="font-size:10px;color:var(--text2)">${escHtml(s.project_name)}</span>` : ''}
      </td>
      <td style="padding:8px 12px;white-space:nowrap;font-size:12px">@${escHtml(s.source_username || '-')}</td>
      <td style="padding:8px 12px;max-width:280px">
        ${textPreview
          ? `<div style="font-size:12px;line-height:1.5;cursor:pointer" onclick="showScrapeDetail(${s.id},'text')" title="클릭하면 전체 내용">${escHtml(textPreview)}</div>`
          : '<span style="color:var(--text2);font-size:11px">내용 없음</span>'}
      </td>
      <td style="padding:8px 12px;max-width:180px">
        ${commentPreview
          ? `<div style="font-size:12px;line-height:1.5;color:var(--text2)">${escHtml(commentPreview)}</div>`
          : '<span style="color:var(--text2);font-size:11px">-</span>'}
      </td>
      <td style="padding:8px 12px">${mediaCell}</td>
      <td style="padding:8px 12px">
        <a href="${escHtml(s.source_url)}" target="_blank" style="font-size:11px;color:var(--accent2);white-space:nowrap">원본 →</a>
      </td>
      <td style="padding:8px 12px;white-space:nowrap">
        <button class="btn btn-xs btn-red" onclick="deleteScrape(${s.id})">삭제</button>
      </td>
    </tr>`;
  }).join('');

  tbody.innerHTML = rows;
}

async function deleteScrape(id) {
  if (!confirm('이 스크랩 데이터를 삭제할까요?')) return;
  try {
    await api('DELETE', `/api/scrapes/${id}`);
    scrapesData = scrapesData.filter(s => s.id !== id);
    renderScrapes(scrapesData);
    toast('삭제되었습니다.', 'success');
  } catch (e) {
    toast('삭제 실패: ' + e.message, 'error');
  }
}

function showScrapeDetail(id, field) {
  const s = scrapesData.find(x => x.id === id);
  if (!s) return;
  const content = field === 'text' ? s.text_content : s.first_comment;
  alert(content || '(내용 없음)');
}

function exportScrapesCSV() {
  const projectSel = document.getElementById('scrapes-filter-project');
  const accountSel = document.getElementById('scrapes-filter-account');
  const params = new URLSearchParams();
  if (projectSel?.value) params.set('project_id', projectSel.value);
  if (accountSel?.value) params.set('account_id', accountSel.value);
  window.open(`/api/scrapes/export/csv?${params}`, '_blank');
}

function openSheetsModal() {
  // 저장된 설정 불러오기
  api('GET', '/api/scrapes/settings/all').then(settings => {
    const webhookInput = document.getElementById('sheets-webhook-url');
    if (webhookInput && settings.sheets_webhook_url) webhookInput.value = settings.sheets_webhook_url;
    const viewInput = document.getElementById('sheets-view-url');
    if (viewInput && settings.sheets_view_url) viewInput.value = settings.sheets_view_url;
  }).catch(() => {});
  openModal('modal-sheets');
}

async function saveSheetsWebhook() {
  const url = document.getElementById('sheets-webhook-url')?.value?.trim();
  if (!url) { toast('웹훅 URL을 입력하세요.', 'error'); return; }
  const viewUrl = document.getElementById('sheets-view-url')?.value?.trim() || '';
  try {
    await api('POST', '/api/scrapes/settings', { key: 'sheets_webhook_url', value: url });
    await api('POST', '/api/scrapes/settings', { key: 'sheets_view_url', value: viewUrl });
    // "구글시트 보러가기" 버튼 표시 여부 업데이트
    const btn = document.getElementById('open-sheet-btn');
    if (btn) btn.style.display = viewUrl ? 'inline-flex' : 'none';
    toast('저장 완료.', 'success');
    closeModal('modal-sheets');
  } catch (e) {
    toast('저장 실패: ' + e.message, 'error');
  }
}

function openGoogleSheet() {
  api('GET', '/api/scrapes/settings/all').then(settings => {
    const url = settings.sheets_view_url;
    if (url) window.open(url, '_blank');
    else toast('구글 시트 URL이 설정되지 않았습니다. Google Sheets 연동에서 URL을 입력하세요.', 'error');
  }).catch(() => toast('설정을 불러오지 못했습니다.', 'error'));
}

async function testSheetsWebhook() {
  const url = document.getElementById('sheets-webhook-url')?.value?.trim();
  if (!url) { toast('웹훅 URL을 먼저 입력하세요.', 'error'); return; }
  try {
    // 저장 먼저
    await api('POST', '/api/scrapes/settings', { key: 'sheets_webhook_url', value: url });
    // 테스트 전송 (최근 1건 or 빈 배열로 연결 확인)
    const testScrape = scrapesData && scrapesData[0];
    if (testScrape) {
      const result = await api('POST', '/api/scrapes/export/sheets', { scrape_ids: [testScrape.id] });
      toast(`연결 성공! 테스트 데이터 ${result.sent}건 전송됨`, 'success');
    } else {
      // 스크랩 데이터 없으면 빈 rows로 ping
      await api('POST', '/api/scrapes/export/sheets', { scrape_ids: [] });
      toast('연결 성공!', 'success');
    }
  } catch (e) {
    toast('연결 실패: ' + e.message, 'error');
  }
}

async function sendScrapesToSheets(scrapeIds) {
  try {
    const body = scrapeIds ? { scrape_ids: scrapeIds } : {};
    const result = await api('POST', '/api/scrapes/export/sheets', body);
    toast(`Google Sheets 전송 완료 (${result.sent}건)`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

function copyAppsScriptCode() {
  const code = document.getElementById('apps-script-code')?.textContent || '';
  navigator.clipboard.writeText(code).then(() => toast('복사되었습니다.', 'success')).catch(() => {
    toast('복사 실패 — 코드를 직접 선택 후 Ctrl+C 로 복사하세요.', 'error');
  });
}
