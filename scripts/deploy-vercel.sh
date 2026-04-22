#!/usr/bin/env bash
# Vercel 배포 헬퍼 — public/ 만 임시 폴더에 격리하여 정적 사이트로 배포
# (root에 package.json/dist/dist-electron 등이 있으면 Vercel이 잘못 인식하므로 우회)
#
# 사용법:
#   bash scripts/deploy-vercel.sh           # 미리보기
#   bash scripts/deploy-vercel.sh prod      # 프로덕션
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="${TMPDIR:-/tmp}/threads-autoposter-deploy"
TARGET_FLAG=""
if [ "$1" = "prod" ] || [ "$1" = "production" ]; then
  TARGET_FLAG="--prod"
fi

echo "→ 임시 배포 디렉터리: $DEPLOY_DIR"
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR"

cp -R "$ROOT/public/." "$DEPLOY_DIR/"
[ -d "$ROOT/.vercel" ] && cp -R "$ROOT/.vercel" "$DEPLOY_DIR/"

cat > "$DEPLOY_DIR/vercel.json" <<'EOF'
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "public": true,
  "rewrites": [
    { "source": "/download", "destination": "/download.html" }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" }
      ]
    }
  ]
}
EOF

echo "→ 배포 시작${TARGET_FLAG:+ ($TARGET_FLAG)}..."
cd "$DEPLOY_DIR"
npx vercel deploy $TARGET_FLAG --yes
