# syntax=docker/dockerfile:1
# Support in container mode. See docs/container.md.
# Update the base image by replacing both its tag and digest. Update a tool by replacing its version
# and both of its SHA-256 values.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# kubectl and Toolbox for the Toolbox connection. Toolbox is verified with the Cosign signature of
# its SHA256SUMS file. Cosign is removed after the check.
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.34.13
ARG TOOLBOX_VERSION=v0.4.10
ARG COSIGN_VERSION=v3.1.4
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) kubectl_sha=66e8283d52d9bc1f9c0e9daade7c971cd20db5a379306862897dfb25395f3e03 \
             cosign_sha=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2 ;; \
      amd64) kubectl_sha=b4bb494e9466a7a94bb851414548bc0d3e2f8da90757e6eccc3371e648648591 \
             cosign_sha=424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    tmp=$(mktemp -d); cd "$tmp"; \
    get() { curl -fsSL --proto '=https' --retry 3 "$1" -o "$2"; }; \
    check() { echo "$2  $1" | sha256sum --strict -c -; }; \
    get "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/$TARGETARCH/kubectl" kubectl; \
    check kubectl "$kubectl_sha"; install -m 0755 kubectl /usr/local/bin/kubectl; \
    get "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-$TARGETARCH" cosign; \
    check cosign "$cosign_sha"; chmod 0755 cosign; \
    rel="https://github.com/globlit/toolbox/releases/download/$TOOLBOX_VERSION"; \
    for f in "toolbox-linux-$TARGETARCH" VERSION SHA256SUMS SHA256SUMS.sigstore.json; do get "$rel/$f" "$f"; done; \
    ./cosign verify-blob --bundle SHA256SUMS.sigstore.json \
      --certificate-identity "https://github.com/globlit/toolbox/.github/workflows/ci.yml@refs/heads/master" \
      --certificate-oidc-issuer "https://token.actions.githubusercontent.com" SHA256SUMS; \
    [ "$(grep -cE "^[0-9a-f]{64} [ *]toolbox-linux-$TARGETARCH\$" SHA256SUMS)" = 1 ]; \
    grep -E "^[0-9a-f]{64} [ *]toolbox-linux-$TARGETARCH\$" SHA256SUMS | sha256sum --strict -c -; \
    [ "$(tr -d '[:space:]' < VERSION)" = "$TOOLBOX_VERSION" ]; \
    install -m 0755 "toolbox-linux-$TARGETARCH" /usr/local/bin/toolbox; \
    cd /; rm -rf "$tmp"

RUN mkdir -p /app /data && chown node:node /app /data
USER node
ENV PATH=/home/node/.local/bin:$PATH \
    DISABLE_AUTOUPDATER=1

# Claude Code CLI for the "Claude subscription" model sign-in. Not needed with an API key.
RUN curl -fsSL --proto '=https' https://claude.ai/install.sh | bash && claude --version

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node . .
RUN npm run build

ENV SUPPORT_DEPLOYMENT=container \
    SUPPORT_BIND_HOST=0.0.0.0 \
    SUPPORT_PORT=4173 \
    SUPPORT_PUBLIC_ORIGIN=http://127.0.0.1:4173 \
    SUPPORT_DATA_DIR=/data \
    SUPPORT_TOOLBOX_BINARY=/usr/local/bin/toolbox
EXPOSE 4173
VOLUME ["/data"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
