# syntax=docker/dockerfile:1
# Command sandbox of Support. Runs the agent's Claude Code sessions and shell commands. Contains no credentials.
# See docs/container.md.
# Update:
#   to update the base image, replace both its tag and digest.
#   to update a tool, replace its version and both of its SHA-256 values.
FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c

ENV DEBIAN_FRONTEND=noninteractive
RUN <<'EOF'
set -eu

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq ripgrep less file openssh-client unzip xz-utils \
  python3 python3-yaml python-is-python3 \
  dnsutils netcat-openbsd procps iptables util-linux
apt-get clean
rm -rf /var/lib/apt/lists/*
EOF

# Binary tools in /usr/local/bin, each pinned by version and SHA-256 checksum.
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.34.13
ARG HELM_VERSION=v4.3.1
ARG YQ_VERSION=v4.54.1
ARG FLUX_VERSION=2.10.0
ARG KUSTOMIZE_VERSION=v5.8.3
ARG ARGOCD_VERSION=v3.6.1
RUN <<'EOF'
set -eu

case "$TARGETARCH" in
  arm64)
    kubectl_sha=66e8283d52d9bc1f9c0e9daade7c971cd20db5a379306862897dfb25395f3e03
    helm_sha=8cf8f66ecbc252ac8f7f06cca68aba88508ddfde3a6a34feb1678ad1694b4f88
    yq_sha=189088da0c6429ec5178dfaab1a114805f6cab0b61b165ab236efedf1d57a71b
    flux_sha=c3c435052e5e18156858bc73f26bcadb62821a6e30951b4b302beb4e65a532c2
    kustomize_sha=9867b76482cfc6d25b546abc1d2b5a32bd137505aba640649b4b378f64f6d68f
    argocd_sha=6636e9183de7dba666b673a417986e7ff54dbadd948b2f9f6c83bcf7d33ebb94
    ;;
  amd64)
    kubectl_sha=b4bb494e9466a7a94bb851414548bc0d3e2f8da90757e6eccc3371e648648591
    helm_sha=0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b
    yq_sha=8e34fc298390875de416e6a4afcb8cabeceb25d9aa8506c1a2f9353cf702ea5f
    flux_sha=208dd7012c04fedeed5b2d0b6e63df3b15b1c34a381527811685c098bc9f8659
    kustomize_sha=cb9e31198d3f63b44848bd0afc4c8efc56e6cfef9c93a4a39a211940e6decd61
    argocd_sha=46d2fc941071f0a0c36326a67a431d34b1479e1a24737f7b367abc93968beadc
    ;;
  *)
    echo "Unsupported architecture: $TARGETARCH" >&2
    exit 1
    ;;
esac

get() {
  curl -fsSL --proto '=https' --retry 3 "$1" -o "$2"
}

check() {
  echo "$2  $1" | sha256sum --strict -c -
}

tmp="$(mktemp -d)"
cd "$tmp"

get "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/$TARGETARCH/kubectl" kubectl
check kubectl "$kubectl_sha"
install -m 0755 kubectl /usr/local/bin/kubectl

get "https://get.helm.sh/helm-$HELM_VERSION-linux-$TARGETARCH.tar.gz" helm.tgz
check helm.tgz "$helm_sha"
tar -xzf helm.tgz
install -m 0755 "linux-$TARGETARCH/helm" /usr/local/bin/helm

get "https://github.com/mikefarah/yq/releases/download/$YQ_VERSION/yq_linux_$TARGETARCH" yq
check yq "$yq_sha"
install -m 0755 yq /usr/local/bin/yq

get "https://github.com/fluxcd/flux2/releases/download/v$FLUX_VERSION/flux_${FLUX_VERSION}_linux_$TARGETARCH.tar.gz" flux.tgz
check flux.tgz "$flux_sha"
tar -xzf flux.tgz flux
install -m 0755 flux /usr/local/bin/

get "https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F$KUSTOMIZE_VERSION/kustomize_${KUSTOMIZE_VERSION}_linux_$TARGETARCH.tar.gz" kustomize.tgz
check kustomize.tgz "$kustomize_sha"
tar -xzf kustomize.tgz kustomize
install -m 0755 kustomize /usr/local/bin/

get "https://github.com/argoproj/argo-cd/releases/download/$ARGOCD_VERSION/argocd-linux-$TARGETARCH" argocd
check argocd "$argocd_sha"
install -m 0755 argocd /usr/local/bin/argocd

cd /
rm -rf "$tmp"
EOF

# The base image has user "node" with uid 1000. Rename it to "admin": commands and agent sessions run as admin.
# The server runs as "sandboxd", so commands cannot signal it.
RUN <<'EOF'
set -eu

usermod --login admin --home /home/admin --move-home node
groupmod --new-name admin node
useradd --system --no-create-home --shell /usr/sbin/nologin sandboxd
install -d -o admin -g admin -m 0755 /srv/sandbox-runs
EOF

ENV PATH=/home/admin/.local/bin:$PATH \
    DISABLE_AUTOUPDATER=1

# Claude Code for agent sessions.
USER admin
RUN <<'EOF'
set -eu

curl -fsSL --proto '=https' https://claude.ai/install.sh | bash
claude --version
EOF
USER root

COPY --chmod=0755 entrypoint.sh /usr/local/bin/sandbox-entrypoint
COPY --chmod=0755 server.py /usr/local/bin/support-sandbox
# The support command: calls Support tools from Bash and scripts.
COPY --chmod=0755 bin/ /opt/support-agent/bin/

WORKDIR /srv/sandbox-runs
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
CMD ["support-sandbox"]
