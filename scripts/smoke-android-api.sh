#!/usr/bin/env bash
# API smoke for exactly the endpoints the Android app uses (DEPTAI-477), sent with the app's
# headers (x-drivehub-client: app/<VERSION>, x-drivehub-api: 1): version negotiation (+ an
# incompatible app / incompatible API major), password login + 2FA, list, search, mkdir,
# resumable upload (session / chunk / resume offset / complete), download + Range, share create /
# list / revoke, pickup-code claim (PIN) + share list + share download.
# Usage: BASE=http://127.0.0.1:8477 FILES=/path/fs/root ADMIN_PW=... scripts/smoke-android-api.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=${BASE:-http://127.0.0.1:8477}
FILES=${FILES:?fs root for the test mount}
ADMIN=${ADMIN:-admin}
ADMIN_PW=${ADMIN_PW:?admin password}
V=$(tr -d '[:space:]' < VERSION)
APP=(-H "x-drivehub-client: app/$V" -H "x-drivehub-api: 1")
j() { curl -sS -H 'content-type: application/json' "${APP[@]}" "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "${APP[@]}" "$@"; }
n=0; ok() { n=$((n+1)); echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }
chk() { [[ "$1" == "$2" ]] && ok "$3" || fail "$3 (got '$1', want '$2')"; }
totp() { python3 - "$1" <<'PY'
import base64,hmac,hashlib,struct,sys,time
k=base64.b32decode(sys.argv[1]+'='*(-len(sys.argv[1])%8));c=struct.pack('>Q',int(time.time())//30)
h=hmac.new(k,c,hashlib.sha1).digest();o=h[19]&15
print('%06d'%((struct.unpack('>I',h[o:o+4])[0]&0x7fffffff)%1000000))
PY
}

echo "== version negotiation"
VJ=$(curl -sS "$BASE/api/version")
chk "$(jq -r .server_version <<<"$VJ")" "$V" "server_version == VERSION ($V)"
MIN=$(jq -r .min_app_version <<<"$VJ"); ok "min_app_version = $MIN, api_version = $(jq -r .api_version <<<"$VJ")"
[[ "$(printf '%s\n%s\n' "$MIN" "$V" | sort -V | head -1)" == "$MIN" ]] && ok "this app ($V) >= min_app_version ($MIN)" || fail "app below min"
chk "$(code "$BASE/api/v1/health")" 200 "health with app headers → 200"
# incompatible: older app than the minimum → 426 client_too_old; newer API major → 426 server_too_old
R=$(curl -sS -o /tmp/d477-426.json -w '%{http_code}' -H "x-drivehub-client: app/0.0.1" -H "x-drivehub-api: 1" "$BASE/api/v1/health")
chk "$R" 426 "incompatible app 0.0.1 → 426"; chk "$(jq -r .status /tmp/d477-426.json)" client_too_old "  body.status = client_too_old (min_version $(jq -r .min_version /tmp/d477-426.json))"
R=$(curl -sS -o /tmp/d477-426.json -w '%{http_code}' -H "x-drivehub-client: app/$V" -H "x-drivehub-api: 99" "$BASE/api/v1/health")
chk "$R" 426 "app speaking API v99 → 426"; chk "$(jq -r .status /tmp/d477-426.json)" server_too_old "  body.status = server_too_old"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'x-drivehub-client: app/0.0.1' "$BASE/api/auth/login" -d '{"login":"x","password":"y"}')" 426 "login also gated for old app → 426"

echo "== login"
if [ "$(j "$BASE/api/auth/status" | jq -r .initialized)" = false ]; then
  j -X POST "$BASE/api/auth/init" -d "{\"username\":\"$ADMIN\",\"email\":\"admin@example.com\",\"password\":\"$ADMIN_PW\"}" >/dev/null && ok "admin initialized"
fi
chk "$(code -X POST -H 'content-type: application/json' "$BASE/api/auth/login" -d "{\"login\":\"$ADMIN\",\"password\":\"wrong-pass\"}")" 401 "bad password → 401"
TP=$(j -X POST "$BASE/api/auth/login" -d "{\"login\":\"$ADMIN\",\"password\":\"$ADMIN_PW\"}")
AT=$(jq -r .access_token <<<"$TP"); RT=$(jq -r .refresh_token <<<"$TP")
[ "$AT" != null ] && ok "password login (access+refresh)" || fail "login"
A=(-H "authorization: Bearer $AT")
chk "$(j "${A[@]}" "$BASE/api/auth/me" | jq -r .username)" "$ADMIN" "auth/me"
NT=$(j -X POST "$BASE/api/auth/refresh" -d "{\"refresh_token\":\"$RT\"}" | jq -r .access_token)
[ -n "$NT" ] && [ "$NT" != null ] && ok "refresh token → new access token" || fail "refresh"
j "${A[@]}" -X POST "$BASE/api/mounts" -d "{\"name\":\"phone\",\"kind\":\"fs\",\"options\":{\"root\":\"$FILES\"},\"transfer_mode\":\"proxy\"}" >/dev/null

echo "== 2FA"
SEC=$(j "${A[@]}" -X POST "$BASE/api/auth/totp/setup" | jq -r .secret)
j "${A[@]}" -X POST "$BASE/api/auth/totp/enable" -d "{\"code\":\"$(totp "$SEC")\"}" | jq -e .ok >/dev/null && ok "totp enabled"
chk "$(j -X POST "$BASE/api/auth/login" -d "{\"login\":\"$ADMIN\",\"password\":\"$ADMIN_PW\"}" | jq -r .totp_required)" true "login w/o code → totp_required (app shows 2FA prompt)"
sleep 1
AT=$(j -X POST "$BASE/api/auth/login" -d "{\"login\":\"$ADMIN\",\"password\":\"$ADMIN_PW\",\"totp_code\":\"$(totp "$SEC")\"}" | jq -r .access_token)
[ "$AT" != null ] && ok "login with totp_code" || fail "totp login"
A=(-H "authorization: Bearer $AT")

echo "== browse / search"
chk "$(j "${A[@]}" "$BASE/api/fs/list?path=/" | jq -r '.items[].name' | tr '\n' ' ')" "phone " "list / shows mount"
j "${A[@]}" -X POST "$BASE/api/fs/mkdir" -d '{"path":"/phone/docs"}' >/dev/null && ok "mkdir /phone/docs"
echo "hello drivehub android" > "$FILES/docs-note.txt"; mkdir -p "$FILES/docs"; echo "hello drivehub android" > "$FILES/docs/note.txt"
chk "$(j "${A[@]}" "$BASE/api/fs/list?path=/phone/docs&page=0&per_page=500" | jq -r '.items[0].name')" note.txt "list /phone/docs"
j "${A[@]}" -X POST "$BASE/api/search/reindex" >/dev/null || true; sleep 2
S=$(j "${A[@]}" "$BASE/api/search?q=note&limit=20" | jq -r '.hits | length'); [ "$S" -ge 1 ] && ok "search 'note' → $S hit(s)" || fail "search returned $S"

echo "== resumable upload"
head -c 3000000 /dev/urandom > /tmp/d477-up.bin; SZ=3000000
SES=$(j "${A[@]}" -X POST "$BASE/api/fs/uploads" -d "{\"path\":\"/phone/docs/big.bin\",\"size\":$SZ,\"overwrite\":true}")
ID=$(jq -r .id <<<"$SES"); CH=$(jq -r .chunk_size <<<"$SES"); ok "session $ID (chunk_size $CH)"
head -c 1000000 /tmp/d477-up.bin | curl -sS -X PUT "${A[@]}" "${APP[@]}" --data-binary @- "$BASE/api/fs/uploads/$ID?offset=0" >/dev/null
chk "$(j "${A[@]}" "$BASE/api/fs/uploads/$ID" | jq -r .offset)" 1000000 "after a dropped connection the server reports offset=1000000"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${A[@]}" "${APP[@]}" --data-binary 'x' "$BASE/api/fs/uploads/$ID?offset=5")" 409 "wrong offset → 409"
tail -c +1000001 /tmp/d477-up.bin | curl -sS -X PUT "${A[@]}" "${APP[@]}" --data-binary @- "$BASE/api/fs/uploads/$ID?offset=1000000" >/dev/null
chk "$(j "${A[@]}" -X POST "$BASE/api/fs/uploads/$ID/complete" | jq -r .size)" $SZ "complete → size $SZ"
cmp /tmp/d477-up.bin "$FILES/docs/big.bin" && ok "uploaded bytes identical on disk (resumed upload)"

echo "== download / Range"
curl -sS "${A[@]}" "${APP[@]}" "$BASE/api/fs/download?path=/phone/docs/big.bin" -o /tmp/d477-dl.bin; cmp /tmp/d477-up.bin /tmp/d477-dl.bin && ok "full download identical"
CODE=$(curl -s -o /tmp/d477-rng.bin -w '%{http_code}' "${A[@]}" "${APP[@]}" -H 'Range: bytes=1000000-' "$BASE/api/fs/download?path=/phone/docs/big.bin")
chk "$CODE" 206 "Range bytes=1000000- → 206"
tail -c +1000001 /tmp/d477-up.bin | cmp - /tmp/d477-rng.bin && ok "ranged bytes == tail of file (download resume)"
chk "$(code "${A[@]}" "$BASE/api/fs/download?path=/phone/docs/note.txt&preview=true")" 200 "preview=true inline download"

echo "== shares / pickup"
SH=$(j "${A[@]}" -X POST "$BASE/api/shares" -d '{"paths":["/phone/docs"],"perm":"download","days":7,"random_pin":true}')
SID=$(jq -r .id <<<"$SH"); PICK=$(jq -r .pickup_code <<<"$SH"); CODE_=$(jq -r .code <<<"$SH"); PIN=$(jq -r .pin <<<"$SH")
ok "share created id=$SID pickup=$PICK"
[ "$(j "${A[@]}" "$BASE/api/shares" | jq "[.[]|select(.id==$SID)]|length")" = 1 ] && ok "share listed" || fail "share list"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' "${APP[@]}" "$BASE/api/s/claim" -d "{\"code\":\"$CODE_\"}")" 401 "claim without PIN → 401 need_pin"
CL=$(curl -sS -X POST -H 'content-type: application/json' "${APP[@]}" "$BASE/api/s/claim" -d "{\"code\":\"$PICK\"}")
TOK=$(jq -r .token <<<"$CL"); [ "$TOK" != null ] && ok "claim '$PICK' (anonymous) → token, items: $(jq -r '[.items[].name]|join(",")' <<<"$CL")" || fail "claim: $CL"
chk "$(curl -sS "${APP[@]}" "$BASE/api/s/$CODE_/list?path=/docs&t=$TOK" | jq -r '.items|map(.name)|sort|join(",")')" "big.bin,note.txt" "share folder list"
curl -sS "${APP[@]}" "$BASE/api/s/$CODE_/download?path=/docs/note.txt&t=$TOK" | grep -q "hello drivehub android" && ok "share download via visitor token"
chk "$(j "${A[@]}" -X POST "$BASE/api/shares/$SID/revoke" | jq -r '.ok // .revoked // "true"')" true "revoke share"
chk "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' "${APP[@]}" "$BASE/api/s/claim" -d "{\"code\":\"$PICK\"}")" 410 "revoked share → 410"
echo "== OK ($n checks) against $BASE (server $V)"
