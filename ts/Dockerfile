# slopmax in a container. Accounts, settings and the usage ledger live in
# the /data volume.
#
#   docker build -t slopmax ts
#   docker run -d --name slopmax -p 127.0.0.1:7567:7567 -v slopmax:/data slopmax
#   docker exec -it slopmax slopmax login codex --device
#   docker exec slopmax slopmax status
#
# The build stage compiles slopmax ahead of time on Alpine with Bun canary,
# so the binary is linked against musl, the C library of the image it runs
# in. The release workflow builds its musl archives with this stage too
# (`docker build --target build`).

FROM oven/bun:canary-alpine AS build
WORKDIR /src
COPY . .
# Install scripts are skipped: the CLI needs none, and the desktop app's
# would download Electron.
RUN bun install --frozen-lockfile --ignore-scripts \
 && bun run --cwd apps/cli compile \
 && ./apps/cli/dist/slopmax --version

FROM alpine:3
# Bun's runtime, inside the binary, links the C++ runtime; ca-certificates
# gives the system's roots, which slopmax trusts beside Bun's own.
RUN apk add --no-cache ca-certificates libstdc++ libgcc
COPY --from=build /src/apps/cli/dist/slopmax /usr/local/bin/slopmax
# Listening on every address is what a container needs; the doctor notes
# that the proxy is reachable from outside the machine.
ENV SLOPMAX_HOME=/data \
    SLOPMAX_LISTEN=0.0.0.0:7567 \
    SLOPMAX_NO_SERVICE=1
VOLUME /data
EXPOSE 7567
ENTRYPOINT ["slopmax"]
CMD ["serve"]
