FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    HISTFILE=/dev/null \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      bc \
      ca-certificates \
      coreutils \
      curl \
      diffutils \
      dnsutils \
      file \
      findutils \
      gawk \
      git \
      grep \
      gzip \
      iproute2 \
      iputils-ping \
      jq \
      less \
      lsof \
      nano \
      net-tools \
      openssh-client \
      procps \
      python3 \
      sed \
      strace \
      tar \
      tree \
      util-linux \
      vim-tiny \
      wget \
      xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)

COPY bashrc /tmp/clirace-bashrc

# Deployment may originate on Windows. Normalize again inside the image so a
# stale CRLF working tree can never break the interactive prompt.
RUN tr -d '\r' < /tmp/clirace-bashrc > /root/.bashrc \
    && rm /tmp/clirace-bashrc

RUN mkdir -p /workspace

WORKDIR /workspace
CMD ["/bin/bash", "-l"]
