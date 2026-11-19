# DriveHub runtime image: FROM base, adds only the server binary and web assets.
ARG BASE_IMAGE=drivehub-base:latest

FROM rust:1-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /src

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS server
COPY --from=planner /src/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --bin drivehub

FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci || npm install
COPY web/ ./
RUN npm run build

FROM ${BASE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="DriveHub" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/lthero-big/drivehub" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY LICENSE NOTICE THIRD_PARTY.md /usr/share/doc/drivehub/
COPY --from=server /src/target/release/drivehub /usr/local/bin/drivehub
COPY --from=web /web/dist /srv/web
ENV DRIVEHUB_BIND=0.0.0.0:8470 DRIVEHUB_DATA_DIR=/data DRIVEHUB_WEB_DIR=/srv/web DRIVEHUB_CONFIG=/config/drivehub.toml
USER drivehub
VOLUME ["/data", "/config"]
EXPOSE 8470
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1:8470/api/v1/health || exit 1
ENTRYPOINT ["/usr/local/bin/drivehub"]
