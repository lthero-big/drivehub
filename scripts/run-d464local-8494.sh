#!/bin/bash
export DRIVEHUB_BIND=0.0.0.0:8494
export DRIVEHUB_DATA_DIR=/data/alex_wan/Project/drivehub-data-d464local
export DRIVEHUB_WEB_DIR=/data/alex_wan/Project/drivehub/web/dist
export DRIVEHUB_URL=http://192.168.1.61:8494
export RUST_LOG=info,tower_http=warn
exec /data/alex_wan/Project/drivehub-wt-d464local/target/release/drivehub
