#!/usr/bin/env bash
# Write release-manifest.json from already-built artifacts (CI / a release folder).
#
#   scripts/emit-release-manifest.sh --dir out [--version X.Y.Z] [--channel stable] \
#       [--base-url https://…/] [--docker ghcr.io/lthero-big/drivehub:X.Y.Z] [--min-client 0.1.0]
#
# The directory must contain a drivehub-linux-<arch> binary (used both as the server
# artifact and as the `release manifest` tool). An APK named
# drivehub-<ver>-android-*.apk is added with versionCode X*10000+Y*100+Z.
# If DRIVEHUB_RELEASE_KEY is set to a secret-key file, also writes release-manifest.json.sig.
# Without a key the unsigned manifest is still written; the in-server updater will not
# accept it until it is signed with a trusted key. This script never creates a key.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="" VERSION="" CHANNEL=stable BASE="" DOCKER="" MIN_CLIENT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) DIR=$2; shift 2 ;;
    --version) VERSION=$2; shift 2 ;;
    --channel) CHANNEL=$2; shift 2 ;;
    --base-url) BASE=$2; shift 2 ;;
    --docker) DOCKER=$2; shift 2 ;;
    --min-client) MIN_CLIENT=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[[ -n "$DIR" && -d "$DIR" ]] || { echo "--dir <artifact dir> required" >&2; exit 2; }
DIR=$(cd "$DIR" && pwd)
VERSION=${VERSION:-$(tr -d '[:space:]' < VERSION)}
BIN=""
for cand in "$DIR"/drivehub-linux-amd64 "$DIR"/drivehub-linux-arm64; do
  [[ -x "$cand" ]] && { BIN=$cand; break; }
done
[[ -n "$BIN" ]] || { echo "no drivehub-linux-* binary in $DIR" >&2; exit 1; }
PLAT=$(basename "$BIN"); PLAT=${PLAT#drivehub-}

code_from_version() {
  local v=${1#v}
  v=${v%%-*}
  IFS=. read -r a b c <<<"$v"
  echo $(( ${a:-0} * 10000 + ${b:-0} * 100 + ${c:-0} ))
}

ARGS=(--version "$VERSION" --channel "$CHANNEL" --server "$PLAT=$BIN" --out "$DIR/release-manifest.json")
[[ -n "$MIN_CLIENT" ]] && ARGS+=(--min-client "$MIN_CLIENT")
[[ -n "$BASE" ]] && ARGS+=(--base-url "$BASE")
[[ -n "$DOCKER" ]] && ARGS+=(--docker "$DOCKER")
if [[ -f "$DIR/web.tar.gz" ]]; then
  ARGS+=(--web "$DIR/web.tar.gz")
fi
shopt -s nullglob
apks=("$DIR"/drivehub-*-android-*.apk "$DIR"/drivehub-"$VERSION".apk)
shopt -u nullglob
apk=""
for f in "${apks[@]}"; do
  [[ -f "$f" ]] || continue
  apk=$f
  break
done
if [[ -n "$apk" ]]; then
  ARGS+=(--android "$apk=$(code_from_version "$VERSION")")
fi

"$BIN" release manifest "${ARGS[@]}"
if [[ -n "${DRIVEHUB_RELEASE_KEY:-}" ]]; then
  [[ -f "$DRIVEHUB_RELEASE_KEY" ]] || { echo "DRIVEHUB_RELEASE_KEY is not a file" >&2; exit 1; }
  "$BIN" release sign --key "$DRIVEHUB_RELEASE_KEY" "$DIR/release-manifest.json"
  "$BIN" release verify "$DIR/release-manifest.json"
  echo "signed $DIR/release-manifest.json"
else
  echo "unsigned $DIR/release-manifest.json (set DRIVEHUB_RELEASE_KEY to sign; updater requires a trusted signature)"
fi
