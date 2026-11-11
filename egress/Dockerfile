# syntax=docker/dockerfile:1
# Egress proxy of the Support sandbox. Squid allows HTTPS CONNECT to the hostnames of allowlist.txt and nothing else.
# Update: replace the base image tag and digest.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

RUN apt-get update \
 && apt-get install -y --no-install-recommends squid \
 && apt-get clean \
 && find /var/lib/apt/lists -type f -delete

COPY squid.conf /etc/squid/squid.conf
USER proxy
EXPOSE 3128
ENTRYPOINT ["squid", "-N", "-f", "/etc/squid/squid.conf"]
