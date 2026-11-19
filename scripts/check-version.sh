#!/usr/bin/env bash
# Fails (exit 1) when any version consumer disagrees with the VERSION file.
#   scripts/check-version.sh            # consistency only
#   scripts/check-version.sh v0.2.0     # also require the git tag to match (release CI)
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(tr -d '[:space:]' < VERSION)
fail=0
check() { # name actual
  if [[ "$2" == "$V" ]]; then echo "ok   $1 = $2"; else echo "FAIL $1 = '${2}' (VERSION = $V)"; fail=1; fi
}
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "FAIL VERSION '$V' is not semver"; fail=1; }

check Cargo.toml "$(awk '/^\[workspace\.package\]/{p=1;next} /^\[/{p=0} p && /^version *=/{gsub(/.*= *"|".*/,"");print;exit}' Cargo.toml)"
if [[ -f Cargo.lock ]]; then
  while read -r name ver; do check "Cargo.lock:$name" "$ver"; done < <(
    awk '/^name = "drivehub(-[a-z]+)?"$/{gsub(/name = |"/,"");n=$0;getline;gsub(/version = |"/,"");print n, $0}' Cargo.lock)
fi
check web/package.json "$(node -p 'require("./web/package.json").version')"
if [[ -f web/package-lock.json ]]; then
  check web/package-lock.json "$(node -p 'const j=require("./web/package-lock.json");j.version')"
  check 'web/package-lock.json packages[""]' "$(node -p 'const j=require("./web/package-lock.json");(j.packages&&j.packages[""]||j).version')"
fi
for g in android/app/build.gradle android/app/build.gradle.kts; do
  [[ -f "$g" ]] || continue
  check "$g versionName" "$(sed -nE 's/.*versionName[[:space:]]*=?[[:space:]]*"([^"]*)".*/\1/p' "$g" | head -1)"
  IFS=. read -r a b c <<<"${V%%-*}"
  code=$(sed -nE 's/.*versionCode[[:space:]]*=?[[:space:]]*([0-9]+).*/\1/p' "$g" | head -1)
  if [[ "$code" == "$((a*10000+b*100+c))" ]]; then echo "ok   $g versionCode = $code"; else echo "FAIL $g versionCode = $code (want $((a*10000+b*100+c)))"; fail=1; fi
done
check deploy/docker-compose.yml "$(sed -nE 's/.*\$\{DRIVEHUB_TAG:-([^}]*)\}.*/\1/p' deploy/docker-compose.yml | head -1)"
if [[ $# -ge 1 ]]; then check "git tag $1" "${1#v}"; fi
if [[ $fail -ne 0 ]]; then echo "version mismatch — run scripts/bump-version.sh to resync" >&2; exit 1; fi
echo "all version consumers = $V"
