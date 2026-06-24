# CI Runners (self-hosted on obx2)

GitHub-hosted Actions are disabled on this account (billing/spending limit), so
CI runs on **self-hosted runners on the `obx2` server** — free compute we own.
No runners run on local machines.

## Current setup

- **3 runners on obx2** (`obx2-tat2-1/2/3`), installed as systemd services
  (`~/actions-runners/tat2-*`), labels: `self-hosted, obx2`.
- They auto-start on boot and reconnect automatically.
- obx2 is provisioned with Node, pnpm, Rust, and the Tauri Linux build deps.

`.github/workflows/ci.yml` targets `runs-on: [self-hosted, obx2]`:
- **Every push/PR:** `check` job — typecheck + unit tests + `cargo fmt --check`
  + `cargo check` (fast once each runner's cache is warm).
- **Tags / manual dispatch only:** `build-linux` (full `.deb` + AppImage) — heavy
  release compile, kept off the per-push path.
- **macOS/Windows bundles:** `build-hosted` job, dormant behind `workflow_dispatch`
  until GitHub-hosted billing is re-enabled.

## Managing the runners

```bash
ssh obx2
cd ~/actions-runners/tat2-1            # or -2 / -3
sudo ./svc.sh status                   # check
sudo ./svc.sh stop|start               # control
```

## Using obx2 as a fallback for other personal projects

GitHub scopes self-hosted runners to a **repository or an organization** — there
is no personal-account-wide scope. So attach obx2 to each personal repo you want
it on, using the helper on the server:

```bash
# 1) On a gh-authed machine, mint a registration token for the target repo:
TOKEN=$(gh api -X POST repos/<OWNER>/<REPO>/actions/runners/registration-token --jq .token)

# 2) Attach an obx2 runner to that repo (installs a systemd service):
ssh obx2 "~/actions-runners/add-repo-runner.sh <OWNER>/<REPO> $TOKEN"
```

The runner gets labels `self-hosted, obx2, fallback`; target jobs with
`runs-on: [self-hosted, obx2]`.

**For true automatic coverage of many repos**, move them under a GitHub
**organization** and register an org-level runner once — it serves every repo in
the org. That's the only native "many repos, one runner" path.
