#!/bin/bash
export DRIVEHUB_BIND=0.0.0.0:8492
export DRIVEHUB_DATA_DIR=/data/alex_wan/Project/drivehub-d485r7-data
export DRIVEHUB_WEB_DIR=/data/alex_wan/Project/drivehub-wt-d485r7/web/dist
export DRIVEHUB_URL=http://192.168.1.61:8492
export RUST_LOG=info,tower_http=warn
exec /data/alex_wan/Project/drivehub/target/release/drivehub
