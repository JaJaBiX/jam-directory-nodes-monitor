# JoinMarket Directory Nodes Monitor

This project monitors JoinMarket onion directory nodes and publishes a static
status page with machine-readable JSON data.

It has two parts:

- a runtime container for a VPS, deployed with Docker Compose, that polls
  directory nodes through Tor, logs results, aggregates history, and publishes
  generated files to a dedicated Git branch with a force push;
- a static web UI that reads `data/latest.json` and `data/history.json` and is
  served by GitHub Pages from the publication branch.

## Runtime

The monitor talks to JoinMarket directory nodes directly over the onion message
protocol:

1. connect to `<node>.onion:5222` through a Tor SOCKS5 proxy;
2. send a non-directory JoinMarket handshake;
3. publish `!orderbook`;
4. collect offer and fidelity-bond replies for a bounded time window.

The container defaults to `network_mode: host`, so it can use Tor already
running on the deployment host at `127.0.0.1:9050`.

History retention is time-bounded:

- `HISTORY_RETENTION_DAYS` keeps at most the most recent N days (capped at 30);
- `MAX_HISTORY_SAMPLES` can additionally cap stored rows (set `0` to disable).

```bash
cp .env.example .env
docker compose up -d --build
```

Run one local probe without publishing:

```bash
python3 -m monitor run-once --nodes-file config/nodes.example.json
```

The canonical image is published to GHCR as
`ghcr.io/jajabix/jam-directory-nodes-monitor:latest` by GitHub Actions.
Set `MONITOR_IMAGE` to pin a specific tag when needed.
The workflow definition lives at `.github/workflows/build-image.yml`.

## Publication

Generated output is written to `web/data/` and then copied to a temporary
publication worktree. The publisher creates a single commit and force-pushes it
to `PUBLICATION_BRANCH`, so the publication branch does not accumulate history.
The publication tree excludes `.github/` because GitHub rejects workflow-file
updates made with repository deploy keys unless the creating OAuth token has the
extra workflow scope.

Required environment for publishing:

- `PUBLISH_ENABLED=true`
- `PUBLISH_REMOTE_URL=git@github.com:<owner>/<repo>.git`
- `PUBLICATION_BRANCH=pages`

Use any Git remote you control for publication (GitHub, Gitea, and so on).

The Docker image contains `git`, `ssh`, and `gh`. The Compose file mounts the
host paths configured by `SSH_DIR` and `GH_CONFIG_DIR` read-only so the
container can use existing GitHub authentication.

## JSON Outputs

- `web/data/latest.json` contains the latest run, per-node results, and summary.
- `summary.offers_total` is the unique deduplicated offer count across all DNs
  (same value as `summary.offers_unique_total`).
- `web/data/latest.json` also includes an aggregated deduplicated orderbook
  (`orderbook.offers`) merged from the latest successful node probes. The web
  UI uses this list to run a fee-limit calculator for user-entered transaction
  amounts.
- `web/data/history.json` contains per-node samples with retained history
  limited to the latest 30 days.
- `data/probes.jsonl` contains append-only runtime logs inside the container
  data volume.

## Deploy

The parent repository contains the `directory_nodes_monitor` Ansible role and
`ansible/playbooks/directory_nodes_monitor.yml`. Run it through `ansiblew`, not
directly through `ansible-playbook`.
