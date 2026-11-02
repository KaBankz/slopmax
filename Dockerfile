# slopmax in a container. Accounts, config, and the usage ledger live in
# the /data volume.
#
#   docker build -t slopmax .
#   docker run -d --name slopmax -p 127.0.0.1:7567:7567 -v slopmax:/data slopmax
#   docker exec -it slopmax slopmax login codex --device
#   docker exec slopmax slopmax status

# The web UI the binary serves, built from ts/apps/ui.
FROM oven/bun:1.4.4-alpine AS ui
WORKDIR /src/ts
COPY ts/ ./
RUN bun install --frozen-lockfile && bun apps/ui/build.ts --rust

FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY . .
COPY --from=ui /src/ts/apps/ui/dist/rust /ui
ENV SLOPMAX_UI_DIST=/ui SLOPMAX_UI_REQUIRED=1
# A container usually serves several machines, so it trades some memory for
# mimalloc's throughput under concurrent streams.
RUN cargo build --release --locked -p slopmax --features mimalloc

FROM alpine:3
RUN apk add --no-cache ca-certificates
COPY --from=build /src/target/release/slopmax /usr/local/bin/slopmax
ENV SLOPMAX_WORKERS=auto \
    SLOPMAX_HOME=/data \
    SLOPMAX_LISTEN=0.0.0.0:7567
VOLUME /data
EXPOSE 7567
ENTRYPOINT ["slopmax"]
CMD ["serve"]
