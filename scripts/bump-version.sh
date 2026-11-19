#!/usr/bin/env bash
# Single source of truth for the release version: the VERSION file at the repo root.
#   scripts/bump-version.sh 0.2.0      # write VERSION and sync every consumer
#   scripts/bump-version.sh            # re-sync consumers from the current VERSION
# Consumers: Cargo.toml [workspace.package] (+ Cargo.lock drivehub-* entries),
# web/package.json (+ package-lock.json), android versionName/versionCode (if android/ exists),
# deploy/docker-compose.yml default image tag. Verify with scripts/check-version.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ge 1 ]]; then
  NEW="${1#v}"
  printf '%s\n' "$NEW" > VERSION
fi
V=$(tr -d '[:space:]' < VERSION)
if ! [[ "$V" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "VERSION '$V' is not semver (X.Y.Z[-pre])" >&2; exit 1
fi
MAJ=${BASH_REMATCH[1]} MIN=${BASH_REMATCH[2]} PAT=${BASH_REMATCH[3]}
# Android versionCode: monotonic integer derived from X.Y.Z (X*10000 + Y*100 + Z).
CODE=$(( MAJ * 10000 + MIN * 100 + PAT ))

# Cargo workspace version (first `version =` inside [workspace.package]).
awk -v v="$V" '
  /^\[workspace\.package\]/ {inpkg=1}
  /^\[/ && !/^\[workspace\.package\]/ {inpkg=0}
  inpkg && /^version *=/ && !done {print "version = \"" v "\""; done=1; next}
  {print}' Cargo.toml > Cargo.toml.tmp && mv Cargo.toml.tmp Cargo.toml

# Cargo.lock: the package entries of our own workspace crates.
if [[ -f Cargo.lock ]]; then
  awk -v v="$V" '
    /^name = "drivehub(-[a-z]+)?"$/ {own=1; print; next}
    own && /^version = / {print "version = \"" v "\""; own=0; next}
    {own=0; print}' Cargo.lock > Cargo.lock.tmp && mv Cargo.lock.tmp Cargo.lock
fi

# web/package.json + package-lock.json (root + packages[""]).
node - "$V" <<'JS'
const fs = require("fs");
const v = process.argv[2];
for (const f of ["web/package.json", "web/package-lock.json"]) {
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = v;
  if (j.packages && j.packages[""]) j.packages[""].version = v;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}
JS

# Android (Gradle Groovy or Kotlin DSL), only if the app exists.
for g in android/app/build.gradle android/app/build.gradle.kts; do
  [[ -f "$g" ]] || continue
  sed -E -i \
    -e "s/(versionName[[:space:]]*=?[[:space:]]*)\"[^\"]*\"/\1\"$V\"/" \
    -e "s/(versionCode[[:space:]]*=?[[:space:]]*)[0-9]+/\1$CODE/" "$g"
done

# docker-compose default tag: image: ${DRIVEHUB_IMAGE:-drivehub}:${DRIVEHUB_TAG:-X.Y.Z}
sed -E -i "s/(\\\$\{DRIVEHUB_TAG:-)[^}]*\}/\1$V}/" deploy/docker-compose.yml

echo "synced version $V (android versionCode $CODE)"
