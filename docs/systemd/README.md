# Reconciler cron — systemd user units (Linux / WSL)

Periodic job that scans `~/.claude/projects/**/*.jsonl` for session drift against
Langfuse and re-executes the hook on any drifted session. Guarantees eventual
consistency even if a Claude Code session crashes, is `kill -9`'d, or the
machine reboots before `Stop` fires.

## Install

```bash
# 1. Create the env file with your Langfuse credentials
mkdir -p ~/.atlax-ai
cat > ~/.atlax-ai/reconcile.env <<'EOF'
LANGFUSE_HOST=https://langfuse.atlax360.com
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
WINDOW_HOURS=24
EOF
chmod 600 ~/.atlax-ai/reconcile.env

# 2. Install the user units
mkdir -p ~/.config/systemd/user
cp docs/systemd/atlax-langfuse-reconcile.{service,timer} ~/.config/systemd/user/

# 3. Enable and start
systemctl --user daemon-reload
systemctl --user enable --now atlax-langfuse-reconcile.timer
```

## Verify

```bash
# Next scheduled tick
systemctl --user list-timers atlax-langfuse-reconcile.timer

# Run once on demand
systemctl --user start atlax-langfuse-reconcile.service

# Inspect logs (structured JSON)
journalctl --user -u atlax-langfuse-reconcile.service -n 50 --no-pager
```

## WSL note

On WSL, systemd user units only run while the WSL instance is alive — they
don't execute while WSL is fully shut down. Acceptable for individual dev
workstations (sessions are only at risk of drift while Claude Code is actually
running, which requires WSL to be up anyway). For servers, use a system-level
unit instead.

To keep systemd user sessions alive on logout:

```bash
sudo loginctl enable-linger $USER
```

## Uninstall

```bash
systemctl --user disable --now atlax-langfuse-reconcile.timer
rm ~/.config/systemd/user/atlax-langfuse-reconcile.{service,timer}
systemctl --user daemon-reload
rm ~/.atlax-ai/reconcile.env
```

## Tuning

- `OnUnitActiveSec=15min` in the `.timer` file controls cadence.
- `WINDOW_HOURS` in `reconcile.env` controls how far back the scanner looks
  (default 24h). Widen to `72` or more for machines with long-running sessions.
- `DRY_RUN=1` in `reconcile.env` disables actual repairs while still logging
  detected drift — useful for observability validation before enforcement.

## Paths in this file

- Service unit assumes repo at `~/work/atlax-langfuse-bridge` and Bun at
  `~/.bun/bin/bun`. Adjust `WorkingDirectory` and `ExecStart` if different.
