#!/bin/bash
export DRIVEHUB_BIND=0.0.0.0:8493
export DRIVEHUB_DATA_DIR=/data/alex_wan/Project/drivehub-d485r8-data
export DRIVEHUB_WEB_DIR=/data/alex_wan/Project/drivehub-wt-d485r8/web/dist
export DRIVEHUB_URL=http://192.168.1.61:8493
export RUST_LOG=info,tower_http=warn
exec /data/alex_wan/Project/drivehub-wt-d485r8/target/release/drivehub
