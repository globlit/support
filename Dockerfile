# syntax=docker/dockerfile:1
# Support in container mode. See docs/container.md.
# Update the base image by replacing both its tag and digest. Update a tool by replacing its version
# and both of its SHA-256 values.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# kubectl merges the kubeconfig files imported in Settings → Connections → Kubernetes.
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.34.13
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) kubectl_sha=66e8283d52d9bc1f9c0e9daade7c971cd20db5a379306862897dfb25395f3e03 ;; \
      amd64) kubectl_sha=b4bb494e9466a7a94bb851414548bc0d3e2f8da90757e6eccc3371e648648591 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    tmp=$(mktemp -d); cd "$tmp"; \
    curl -fsSL --proto '=https' --retry 3 "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/$TARGETARCH/kubectl" -o kubectl; \
    echo "$kubectl_sha  kubectl" | sha256sum --strict -c -; \
    install -m 0755 kubectl /usr/local/bin/kubectl; \
    cd /; rm -rf "$tmp"

RUN mkdir -p /app /data && chown node:node /app /data
USER node

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node . .
RUN npm run build

ENV SUPPORT_DEPLOYMENT=container \
    SUPPORT_BIND_HOST=0.0.0.0 \
    SUPPORT_PORT=4173 \
    SUPPORT_PUBLIC_ORIGIN=http://127.0.0.1:4173 \
    SUPPORT_DATA_DIR=/data
EXPOSE 4173
VOLUME ["/data"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
