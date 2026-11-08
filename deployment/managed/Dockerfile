# Release build only. Both image arguments MUST be reviewed immutable digests.
ARG NODE_IMAGE
ARG UBUNTU_IMAGE
FROM ${NODE_IMAGE} AS node
FROM ${UBUNTU_IMAGE}
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN test "$TARGETARCH" = arm64 -o "$TARGETARCH" = amd64 \
 && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d \
 && apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv python3 ca-certificates libstdc++6 libatomic1 git curl linux-image-virtual initramfs-tools \
 && useradd --system --create-home --home-dir /var/lib/support --shell /usr/sbin/nologin support \
 && useradd --system --no-create-home --shell /usr/sbin/nologin support-bridge \
 && mkdir -p /workspace /opt/support-bridge /etc/modules-load.d \
 && chown support:support /workspace \
 && printf 'virtio_vsock\n' > /etc/modules-load.d/support-vsock.conf \
 && printf 'virtio_blk\nvirtio_pci\nvirtio_mmio\nvirtio_console\nvirtio_vsock\next4\n' >> /etc/initramfs-tools/modules \
 && update-initramfs -u -k all \
 && rm /usr/sbin/policy-rc.d \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY guest-dist/app /opt/support
COPY deployment/managed/guest-bridge.py /opt/support-bridge/guest-bridge.py
COPY deployment/managed/support.service deployment/managed/support-api.service deployment/managed/support-proxy.service /etc/systemd/system/
RUN node --version && systemctl enable support.service support-api.service support-proxy.service \
 && systemctl mask ssh.service ssh.socket systemd-networkd.service systemd-networkd.socket NetworkManager.service \
 && : > /etc/machine-id && rm -f /var/lib/dbus/machine-id \
 && ln -s /etc/machine-id /var/lib/dbus/machine-id
# No SSH server, passwords, service tokens, Docker socket or host integration agent.
CMD ["/sbin/init"]
