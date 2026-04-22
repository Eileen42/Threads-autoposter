#!/usr/bin/env bash
# Vercel Build Output API v3 형식으로 public/만 정적 사이트로 출력
set -e
mkdir -p .vercel/output/static
cp -R public/. .vercel/output/static/

cat > .vercel/output/config.json <<'EOF'
{
  "version": 3,
  "routes": [
    { "src": "/download", "dest": "/download.html" },
    {
      "src": "/(.*)",
      "headers": {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      },
      "continue": true
    }
  ]
}
EOF

echo "✓ .vercel/output ready"
ls .vercel/output/static | head -10
