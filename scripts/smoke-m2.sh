#!/usr/bin/env bash
# M2 smoke test against a running server (fresh data dir expected, or ADMIN_PW of the
# existing admin): init admin, login, register toggle, TOTP, API token, ACL deny,
# WebDAV via rclone (list / upload / download / range / deny).
# Usage: BASE=http://127.0.0.1:8473 FILES=/path/to/fs/root ADMIN_PW=... scripts/smoke-m2.sh
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:8473}
FILES=${FILES:?fs root for the test mount}
ADMIN=${ADMIN:-admin}
ADMIN_PW=${ADMIN_PW:?admin password}
RCLONE=${RCLONE:-$(command -v rclone || echo ~/.local/bin/rclone)}
j() { curl -sS -H 'content-type: application/json' "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
ok() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*"; exit 1; }
totp() { python3 - "$1" <<'PY'
import base64,hmac,hashlib,struct,sys,time
k=base64.b32decode(sys.argv[1]+'='*(-len(sys.argv[1])%8));c=struct.pack('>Q',int(time.time())//30)
h=hmac.new(k,c,hashlib.sha1).digest();o=h[19]&15
print('%06d'%((struct.unpack('>I',h[o:o+4])[0]&0x7fffffff)%1000000))
PY
}

echo "== auth"
if [ "$(j "$BASE/api/auth/status" | jq -r .initialized)" = false ]; then
  j -X POST "$BASE/api/auth/init" -d "{\"username\":\"$ADMIN\",\"email\":\"admin@example.com\",\"password\":\"$ADMIN_PW\"}" >/dev/null && ok "admin initialized"
fi
[ "$(code -X POST -H 'content-type: application/json' "$BASE/api/auth/init" -d '{"username":"x","password":"xxxxxxxxxx"}')" = 409 ] && ok "second init → 409"
AT=$(j -X POST "$BASE/api/auth/login" -d "{\"login\":\"$ADMIN\",\"password\":\"$ADMIN_PW\"}" | jq -r .access_token)
[ "$AT" != null ] && ok "admin login" || fail "admin login"
A=(-H "authorization: Bearer $AT")
j "${A[@]}" -X POST "$BASE/api/mounts" -d "{\"name\":\"smoke\",\"kind\":\"fs\",\"options\":{\"root\":\"$FILES\"},\"transfer_mode\":\"proxy\"}" >/dev/null
j "${A[@]}" -X PUT "$BASE/api/admin/settings" -d '{"open_registration":false}' >/dev/null
[ "$(code -X POST -H 'content-type: application/json' "$BASE/api/auth/register" -d '{"email":"u1@example.com","password":"user1-pass"}')" = 403 ] && ok "register closed → 403"
j "${A[@]}" -X PUT "$BASE/api/admin/settings" -d '{"open_registration":true}' >/dev/null
R=$(j -X POST "$BASE/api/auth/register" -d '{"username":"smokeuser","email":"smoke@example.com","password":"smoke-pass-1"}')
UT=$(echo "$R" | jq -r '.tokens.access_token // empty')
if [ -z "$UT" ]; then UT=$(j -X POST "$BASE/api/auth/login" -d '{"login":"smokeuser","password":"smoke-pass-1"}' | jq -r .access_token); fi
U=(-H "authorization: Bearer $UT")
ok "register open → user created ($(j "${U[@]}" "$BASE/api/auth/me" | jq -r .username))"
j "${A[@]}" -X PUT "$BASE/api/admin/settings" -d '{"open_registration":false}' >/dev/null

echo "== totp"
SEC=$(j "${U[@]}" -X POST "$BASE/api/auth/totp/setup" | jq -r .secret)
j "${U[@]}" -X POST "$BASE/api/auth/totp/enable" -d "{\"code\":\"$(totp "$SEC")\"}" | jq -e .ok >/dev/null && ok "totp enabled"
[ "$(j -X POST "$BASE/api/auth/login" -d '{"login":"smokeuser","password":"smoke-pass-1"}' | jq -r .totp_required)" = true ] && ok "login without code → totp_required"
UT=$(j -X POST "$BASE/api/auth/login" -d "{\"login\":\"smokeuser\",\"password\":\"smoke-pass-1\",\"totp_code\":\"$(totp "$SEC")\"}" | jq -r .access_token)
U=(-H "authorization: Bearer $UT"); [ "$UT" != null ] && ok "login with totp"

echo "== api token / app password"
PAT=$(j "${U[@]}" -X POST "$BASE/api/auth/tokens" -d '{"name":"smoke"}' | jq -r .token)
[ "$(j -H "authorization: Bearer $PAT" "$BASE/api/auth/me" | jq -r .auth_via)" = api_token ] && ok "API token auth"
APW=$(j "${U[@]}" -X POST "$BASE/api/auth/app-passwords" -d '{"name":"rclone"}' | jq -r .password)
ok "app password created"

echo "== acl"
j "${A[@]}" -X POST "$BASE/api/acl/rules" -d '{"path":"/smoke/secret","subject":"logged_in","deny":["read","download"]}' >/dev/null
UID_=$(j "${U[@]}" "$BASE/api/auth/me" | jq -r .id)
j "${A[@]}" -X POST "$BASE/api/acl/rules" -d "{\"path\":\"/smoke/team\",\"subject\":\"user\",\"subject_id\":$UID_,\"allow\":[\"upload\",\"create\",\"edit\",\"delete\"]}" >/dev/null
[ "$(code "${U[@]}" "$BASE/api/fs/list?path=/smoke/secret")" = 403 ] && ok "API list /smoke/secret → 403"
[ "$(code "${U[@]}" -X PUT --data-binary x "$BASE/api/fs/upload?path=/smoke/pub/x.txt")" = 403 ] && ok "API upload to read-only dir → 403"
[ "$(code "${U[@]}" -X PUT --data-binary x "$BASE/api/fs/upload?path=/smoke/team/api.txt")" = 200 ] && ok "API upload to team → 200"
[ "$(code "$BASE/api/fs/list?path=/smoke")" = 401 ] && ok "anonymous → 401"
echo "  effective(/smoke/secret): $(j "${U[@]}" "$BASE/api/acl/effective?path=/smoke/secret/c.txt" | jq -c .permissions)"

echo "== webdav (rclone)"
OBS=$("$RCLONE" obscure "$APW")
RC=("$RCLONE" --config /dev/null --webdav-url "$BASE/dav" --webdav-vendor other --webdav-user smokeuser --webdav-pass "$OBS")
"${RC[@]}" lsf :webdav:/ | grep -q smoke && ok "rclone lsf / shows mount"
L=$("${RC[@]}" lsf :webdav:/smoke/ | tr '\n' ' '); echo "  /smoke: $L"; echo "$L" | grep -q secret && fail "secret visible over DAV" || ok "secret hidden over DAV"
head -c 3000000 /dev/urandom > /tmp/dh-smoke.bin
"${RC[@]}" copyto /tmp/dh-smoke.bin :webdav:/smoke/team/up.bin && ok "rclone upload 3MB to team"
"${RC[@]}" copyto :webdav:/smoke/team/up.bin /tmp/dh-smoke.dl && cmp /tmp/dh-smoke.bin /tmp/dh-smoke.dl && ok "rclone download matches"
"${RC[@]}" copyto /tmp/dh-smoke.bin :webdav:/smoke/pub/deny.bin 2>/dev/null && fail "upload to pub allowed" || ok "rclone upload to pub denied"
"${RC[@]}" cat :webdav:/smoke/secret/c.txt 2>/dev/null && fail "secret readable" || ok "rclone read secret denied"
R=$(curl -s -o /dev/null -w '%{http_code}' -u "smokeuser:$APW" -H 'Range: bytes=10-19' "$BASE/dav/smoke/pub/big.bin"); [ "$R" = 206 ] && ok "DAV Range → 206"
[ "$(code -u "smokeuser:smoke-pass-1" -X PROPFIND "$BASE/dav/")" = 401 ] && ok "account password refused for DAV when TOTP on"
[ "$(code -u "smokeuser:$PAT" -X PROPFIND -H 'depth: 1' "$BASE/dav/smoke/")" = 207 ] && ok "API token as DAV password → 207"
"${RC[@]}" deletefile :webdav:/smoke/team/up.bin && ok "rclone delete in team"
sleep 0.3
echo "== audit (denied, latest)"
j "${A[@]}" "$BASE/api/admin/audit?denied=true&limit=8" | jq -r '.[] | "  \(.channel)\t\(.username)\t\(.action)\t\(.path)\t\(.detail)"'
echo "SMOKE OK"
