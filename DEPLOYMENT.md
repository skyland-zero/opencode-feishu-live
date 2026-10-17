# Deployment Guide

Target OS: Linux with `systemd --user`.

## 1. Install & configure

```bash
cd /root/dev/opencode-feishu-live
npm install
cp .env.example .env.runtime
# edit .env.runtime: FEISHU_APP_ID, FEISHU_APP_SECRET, OPENCODE_PATH, OPENCODE_WORKING_DIR
chmod 600 .env.runtime
bash scripts/preflight.sh
npm run build
```

## 2. Install as user service

```bash
bash scripts/install-systemd-user.sh
```

The installer enables linger so the service starts after reboot.

## 3. Verify

```bash
systemctl --user status opencode-feishu-live.service --no-pager
tail -f /root/dev/opencode-feishu-live/logs/systemd-bridge.log
```

Expected log lines: `ws client ready` (Feishu) and `ACP initialized` (opencode).

Then send `!status` to the bot in Feishu.

## 4. Upgrade flow

```bash
cd /root/dev/opencode-feishu-live
git pull
npm install
npm run build
systemctl --user restart opencode-feishu-live.service
```

## 5. Security rules

- Never commit `.env.runtime` (contains app secret)
- Rotate the Feishu app secret immediately if it leaks
- `OPENCODE_PERMISSION_MODE=reject` makes the bot never auto-approve sensitive tool permissions
