# DriveHub base image: system/runtime deps only. Rebuild only when this file changes;
# tag with the hash of this file (see deploy/build.sh), e.g. drivehub-base:<sha12>.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata rclone ffmpeg fonts-noto-cjk curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -r -u 10001 -d /data drivehub \
 && mkdir -p /data /config && chown drivehub /data /config
