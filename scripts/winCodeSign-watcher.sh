#!/usr/bin/env bash
# electron-builder가 winCodeSign .7z 다운로드 직후 즉시 darwin 제외 재추출 (Windows symlink 권한 우회)
CACHE="C:/Users/tofha/AppData/Local/electron-builder/Cache/winCodeSign"
SEVZ="D:/coding/threads-autoposter/node_modules/7zip-bin/win/x64/7za.exe"
mkdir -p "$CACHE"
echo "[watcher] started, watching $CACHE"
declare -A done
while true; do
  for f in "$CACHE"/*.7z; do
    [ -f "$f" ] || continue
    hash="${f%.7z}"
    key="$f-$(stat -c %Y "$f" 2>/dev/null || echo 0)"
    if [ -z "${done[$key]}" ]; then
      rm -rf "$hash"
      "$SEVZ" x "$f" -o"$hash" -xr!darwin -xr!*.dylib -y > /dev/null 2>&1 \
        && echo "[watcher] re-extracted $(basename $hash)" \
        || echo "[watcher] failed $(basename $hash)"
      done[$key]=1
    fi
  done
  sleep 0.2
done
