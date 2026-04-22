# Threads AutoPoster — CLAUDE.md

## 최상위 규칙
- **지시한 것 이외의 기능이나 인터페이스는 임의로 수정, 축소, 생략, 삭제 금지**
- 요청된 변경사항만 정확히 반영. 주변 코드 리팩터링·"개선"·정리 일체 금지
- 요청 범위 밖의 코드는 절대 손대지 말 것

---

## 프로젝트 개요
- **목적**: Threads SNS 자동 포스팅 도구 — AI 콘텐츠 생성 + 예약 발행 + 벤치마킹 스크랩
- **서버**: Express (포트 4000), Node.js 22.5+ 내장 SQLite
- **프론트**: `public/index.html` + `public/js/app.js` (Vanilla JS SPA, 별도 빌드 없음)
- **실행**: `npm run dev` (tsx watch) / `npm start` (빌드 후)

---

## 파일 구조

```
src/
  index.ts                  # 진입점
  server/
    app.ts                  # Express 앱, 포트 4000
    routes/
      projects.ts           # 프로젝트/계정/AI설정/템플릿/스케줄/벤치마킹 설정 CRUD
      posts.ts              # 포스트 상태관리, 승인/반려/발행/예약
      benchmarking.ts       # 벤치마킹 실행/진행상황 조회
      scrapes.ts            # 스크랩 데이터 조회/삭제
      google.ts             # Google OAuth/Sheets 연동
  storage/
    db.ts                   # SQLite DB 초기화 + 모든 쿼리 (migrations 포함)
  ai/
    aiClient.ts             # Playwright로 Claude/Gemini/Genspark 자동화
  threads/
    threadsApi.ts           # Threads 공식 Graph API (App ID: 932119622652179)
    threadsPoster.ts        # Playwright로 Threads 직접 포스팅/네이티브 예약
  scheduler/
    scheduler.ts            # cron 매 분 체크 — 콘텐츠 생성 + 자동 발행(auto mode)
    batchScheduler.ts       # 승인 포스트 일괄 네이티브 예약 (계정별 브라우저 1회 공유)
  benchmarking/
    scraper.ts              # 타겟 계정 포스트 스크래핑 (API 인터셉션 → DOM 폴백)
    runner.ts               # 벤치마킹 풀 워크플로우
    poster.ts               # 미디어 첨부 포스팅/예약 (BenchmarkingPoster)
    mediaDownloader.ts      # 미디어 다운로드 + 임시 파일 관리
    stateManager.ts         # 스크랩 중복 방지 (last_scraped.json)
    types.ts                # PostCard, ScrapedPost 타입
  human/
    humanBehavior.ts        # 딜레이/타이핑/스크롤 인간 행동 모방
  google/
    oauthService.ts         # Google OAuth
    sheetsService.ts        # Google Sheets 동기화
```

---

## DB 스키마 (주요 테이블)

| 테이블 | 설명 |
|--------|------|
| `projects` | 프로젝트 |
| `accounts` | Threads 계정 (profile_dir, access_token, threads_user_id) |
| `ai_configs` | AI 설정 (ai_type: claude/gemini/genspark/custom) |
| `post_templates` | 포스트 템플릿 (main_prompt, comment_template, hashtags) |
| `schedule_rules` | 스케줄 규칙 (preview_time, post_times, active_days) |
| `scheduled_posts` | 포스트 (status, publish_mode, source_type 등) |
| `post_logs` | 포스트별 실행 로그 |
| `benchmarking_jobs` | 벤치마킹 작업 (레거시) |
| `project_benchmarking` | 프로젝트별 벤치마킹 설정 |
| `scrapes` | 스크랩된 원본 데이터 |
| `app_settings` | key-value 앱 설정 (sheets_webhook_url 등) |

### scheduled_posts 상태값 (status)
```
pending_generation → generated → approved → posting → scheduled / posted / failed / skipped
```

### publish_mode
- `'native'` (기본값): Threads 네이티브 예약 — 배치 예약 버튼으로 수동 처리
- `'auto'`: 지정 시간에 서버가 직접 발행 (PC 켜져있어야 함)

### source_type
- `'scheduled'`: 스케줄 규칙으로 생성된 일반 포스트
- `'benchmarking'`: 벤치마킹 스크랩에서 생성된 포스트

---

## 핵심 워크플로우

### 1. 일반 포스팅 플로우
```
스케줄 규칙 설정
  → preview_time 도달 시 cron 트리거
  → AI(Playwright)로 콘텐츠 생성 → status: generated
  → 미리보기 탭에서 검토/수정 → 승인 → status: approved
  → 발행대기 탭:
      [쓰레드 예약] → batchScheduleNative() → Playwright로 네이티브 예약 → status: scheduled
      [자동 발행]   → publish_mode='auto' 설정 → cron이 지정시간에 발행 → status: posted
      [지금 발행]   → 즉시 발행 → status: posted
```

### 2. 벤치마킹 플로우
```
벤치마킹 설정 (타겟URL, AI, 포스팅 계정, 재작성 프롬프트)
  → preview_time 또는 수동 실행
  → 타겟 프로필 스크랩 (API 인터셉션 → DOM 폴백)
  → 미디어 다운로드
  → AI 재작성 (본문 + [댓글] 구분자로 댓글 분리 가능)
  → scrapes 테이블 + scheduled_posts 생성 (source_type='benchmarking')
  → 미리보기에서 원본/재작성 확인 → 승인 → 발행대기
```

### 3. Threads API vs 브라우저 자동화
- 계정에 `access_token` + `threads_user_id` 있으면 → **API 우선** (텍스트 포스트)
- API 실패 또는 미디어 포스트 → **Playwright 브라우저** 폴백
- 벤치마킹 미디어 포스트 → 항상 BenchmarkingPoster (브라우저)

---

## 중요 패턴 / 주의사항

### scheduled_time 처리
- DB에 UTC ISO 포맷(`2025-01-15T09:00:00.000Z`)으로 저장
- SQLite 비교 시 `date(scheduled_time, 'localtime')`으로 변환 후 비교
- JS에서 파싱 시: `rawTime.includes('T') ? new Date(rawTime) : new Date(rawTime.replace(' ', 'T') + 'Z')`

### Playwright 브라우저 프로필
- 경로: `data/browser-profiles/{profile_dir}/`
- 시작 전 `SingletonLock`, `SingletonSocket`, `lockfile` 제거 (Windows stale lock)
- 항상 `headless: false` (Threads 봇 감지 우회)

### Threads 게시글 구조 — 원문 본문 vs 첫 댓글 (FIXED, 절대 혼동 금지)

```
Threads 게시글 페이지 구조:
┌─────────────────────────────────────────┐
│ [원문 본문] 게시글 최상단 텍스트          │  ← text_content / scrapes.text_content
│ (사진/영상, 리뷰, 라이프스타일 등)        │     = thread_items[0].post.caption.text
├─────────────────────────────────────────┤
│ [첫 댓글] 작성자가 연결한 첫 번째 글     │  ← first_comment / scrapes.first_comment
│ (쿠팡 파트너스 공시문, 링크 등)           │     = thread_items[1].post.caption.text
│  또는 고정된 자기 댓글 (☆ 고정됨)        │     (없으면 reply_threads[0] 중 동일 작성자)
├─────────────────────────────────────────┤
│ [일반 댓글들] 다른 유저의 반응            │  ← 저장 안 함
└─────────────────────────────────────────┘
```

**API 파싱 우선순위 (`extractThreadNode`):**
1. `root.containing_thread` — 최우선. `thread_items[0]`=원본, `[1]`=연결글 보장
2. `root.barcelona_thread_by_post_id.containing_thread` — 체인 포스트 URL 방문 시에도 원본 확보
3. `root.barcelona_thread_by_post_id` 직접 — `thread_items[0]`이 연결글일 수 있음 (폴백)

**역전 발생 원인:** 계정 프로필 피드에서 체인 포스트(연결글) URL도 별도로 노출됨
→ 스크래퍼가 그 URL 방문 시 `containing_thread` 없는 응답이 오면 연결글이 `textContent`에 저장
→ 결과: 원문 본문=쿠팡 파트너스 공시문, 첫 댓글=일반 유저 댓글 (역전)
→ **수정:** `extractThreadNode`에서 nested `containing_thread`까지 탐색 (`scraper.ts`)

### 벤치마킹 AI 재작성 프롬프트 플레이스홀더
- `[벤치마킹 원문]` → 스크랩 본문으로 치환
- `[첫 번째 댓글]` → 스크랩 댓글로 치환
- AI 응답에 `\n[댓글]\n` 구분자 있으면 본문/댓글 자동 분리

### DB Migrations
- `db.ts` 하단 `migrations` 배열에 추가 (try/catch — idempotent)
- 새 컬럼은 항상 끝에 추가 (중간 삽입 금지)

### 프론트엔드 (app.js)
- 빌드 없음 — 수정 즉시 브라우저 새로고침으로 반영
- `statusBadge(status)` — 상태별 뱃지 렌더링
- `formatScheduledTime(dt)` — UTC → 로컬 시간 변환 표시
- `pendingAllPosts`, `pendingSelectedIds` — 발행대기 탭 전역 상태
- `previewAllPosts`, `previewProjectFilter`, `previewTypeFilter` — 미리보기 탭 전역 상태

---

## API 엔드포인트 요약

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/projects` | 프로젝트 목록 |
| GET/PUT | `/api/projects/:id/benchmarking` | 벤치마킹 설정 |
| POST | `/api/projects/:id/benchmarking/run` | 벤치마킹 수동 실행 |
| GET | `/api/posts/preview` | 미리보기 목록 (generated+approved) |
| GET | `/api/posts/today` | 오늘 포스트 |
| GET | `/api/posts/recent` | 발행 히스토리 |
| POST | `/api/posts/batch-schedule` | 일괄 네이티브 예약 시작 |
| POST | `/api/posts/publish-mode` | publish_mode 변경 (auto\|native) |
| POST | `/api/posts/:id/approve` | 포스트 승인 |
| POST | `/api/posts/:id/post-now` | 즉시 발행 |
| POST | `/api/posts/:id/regenerate` | AI 콘텐츠 재생성 |
| POST | `/api/posts/:id/bm-rewrite` | 벤치마킹 AI 재작성 재실행 |
| GET | `/api/scheduler/status` | 스케줄러 상태 + 뱃지 카운트 |
| GET | `/api/scheduler/active-tasks` | 현재 실행 중인 작업 |
| GET | `/api/benchmarking/progress` | 벤치마킹 진행상황 |

---

## 환경 / 실행

```bash
npm run dev        # 개발 (tsx watch, 포트 4000)
npm run build      # TypeScript 빌드 → dist/
npm start          # 빌드 결과 실행
npm test           # vitest
```

- DB 파일: `data/autoposter.db`
- 미디어: `data/media/{post_id}/`
- 브라우저 프로필: `data/browser-profiles/`
- 로그: `logs/`
