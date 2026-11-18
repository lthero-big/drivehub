#!/usr/bin/env bash
# 10万条文件元数据关键词搜索基准 (DEPTAI-470)
set -euo pipefail
cd "$(dirname "$0")/.."
cargo run --release -q -p drivehub-search --example bench -- "${1:-100000}"
