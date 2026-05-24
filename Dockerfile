FROM python:3.12-slim

ENV MONITOR_DATA_DIR=/app/data \
    MONITOR_WEB_DIR=/app/web \
    PYTHONUNBUFFERED=1

LABEL org.opencontainers.image.source="https://github.com/JaJaBiX/jam-directory-nodes-monitor"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gpg \
      git \
      openssh-client \
    && mkdir -p /etc/apt/keyrings /etc/ssh \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && ssh-keyscan github.com > /etc/ssh/ssh_known_hosts \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY config ./config
COPY monitor ./monitor
COPY web ./web

RUN python -m compileall monitor

VOLUME ["/app/data", "/app/web/data"]

CMD ["python", "-m", "monitor", "daemon"]
