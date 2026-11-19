#!/usr/bin/env bash
# Download the free offline IP→region database (ip2region v4 xdb, Apache-2.0, ~11 MB)
# into <data_dir>/geoip/ip2region_v4.xdb. DriveHub loads it at startup (or set DRIVEHUB_GEOIP_DB).
# Without it, private / LAN IPs are still labelled "局域网"; public IPs show as unknown.
# usage: scripts/fetch-geoip.sh [data_dir]   (default: $DRIVEHUB_DATA_DIR or ./data)
set -euo pipefail
DIR="${1:-${DRIVEHUB_DATA_DIR:-./data}}/geoip"
mkdir -p "$DIR"
TMP="$DIR/.ip2region_v4.xdb.part"
for url in \
  https://raw.githubusercontent.com/lionsoul2014/ip2region/master/data/ip2region_v4.xdb \
  https://cdn.jsdelivr.net/gh/lionsoul2014/ip2region@master/data/ip2region_v4.xdb; do
  echo "fetching $url"
  if curl -fL --retry 2 -m 300 -o "$TMP" "$url" && [ "$(stat -c %s "$TMP")" -gt 1000000 ]; then
    mv "$TMP" "$DIR/ip2region_v4.xdb"
    echo "ok: $DIR/ip2region_v4.xdb ($(stat -c %s "$DIR/ip2region_v4.xdb") bytes) — restart DriveHub to load it"
    exit 0
  fi
done
rm -f "$TMP"; echo "download failed" >&2; exit 1
