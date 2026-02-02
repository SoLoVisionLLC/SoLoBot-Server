# Model Sync & Gateway Permission Issues - Troubleshooting Report

**Date:** February 2, 2026\
**Systems Affected:** SoLoBot Dashboard, MoltBot (OpenClaw Gateway)\
**Resolution Status:** ✅ Resolved

---

## Executive Summary

The Dashboard was unable to display newly added AI models, and the gateway was
throwing continuous `EACCES: permission denied` errors. The root cause was a
**mismatch between Docker's volume management and file permissions**, compounded
by the Dashboard and Moltbot using **separate storage locations** for the same
configuration files.

**The fix involved:**

1. Switching from Docker named volumes to host bind mounts
2. Copying existing config data from Docker volumes to host paths
3. Setting correct file ownership (UID 1000)
4. Updating both compose files for shared read-write access

---

## Issues Encountered

### Issue 1: Models Not Appearing in Dashboard

- **Symptom:** Newly added models (MiniMax, etc.) did not appear in the
  Dashboard dropdown
- **Error:** None visible; the dropdown simply showed old/default models

### Issue 2: Gateway Permission Denied Errors

- **Symptom:** Continuous error spam in gateway logs
- **Error:**
  `EACCES: permission denied, open '/home/node/.openclaw/openclaw.json'`
- **Impact:** Gateway couldn't read config, causing 502 errors and broken
  functionality

### Issue 3: Config File Desync

- **Symptom:** Changes made via `solobot configure` didn't persist or weren't
  visible to Dashboard
- **Root Cause:** Container had its own copy of files; host had an older version

---

## Root Causes Identified

### 1. Docker Named Volumes vs Bind Mounts

The original `docker-compose.coolify.yml` used **named volumes**:

```yaml
volumes:
    - moltbot-openclaw:/home/node/.openclaw # Named volume
```

Named volumes are managed by Docker and stored in `/var/lib/docker/volumes/`.
They are **isolated** from the host filesystem, meaning the Dashboard (which
reads from `/home/node/.openclaw` on the host) couldn't see changes made inside
the container.

### 2. File Ownership Mismatch

When files were copied between container and host, they ended up owned by
`root`. The gateway process runs as the `node` user (UID 1000), so it couldn't
read root-owned files.

**The problematic ownership:**

```
-rw------- 1 root root 6353 openclaw.json  ❌ Gateway can't read
```

**The correct ownership:**

```
-rw------- 1 ubuntu ubuntu 8145 openclaw.json  ✅ (ubuntu = UID 1000)
```

### 3. Read-Only Volume Mounts

The Dashboard's compose file mounted the config directory as read-only (`:ro`),
preventing it from writing config changes even after other issues were fixed.

---

## Solutions Implemented

### Solution 1: Switch to Host Bind Mounts

**File:** `SoLoBot-Server/docker-compose.coolify.yml`

```yaml
# BEFORE (named volumes - isolated)
volumes:
    - moltbot-openclaw:/home/node/.openclaw

# AFTER (bind mounts - shared with host)
volumes:
    - /home/node/.openclaw:/home/node/.openclaw
```

### Solution 2: Enable Dashboard Write Access

**File:** `SoLoBot-Dashboard/docker-compose.coolify.yml`

```yaml
# BEFORE (read-only)
- /home/node/.openclaw:/app/openclaw:ro

# AFTER (read-write)
- /home/node/.openclaw:/app/openclaw
```

### Solution 3: Migrate Data from Docker Volumes to Host

```bash
# Copy data from Docker volume to host path
sudo docker run --rm \
  -v a88sw4go8wc8wo4k4okg48cs_moltbot-openclaw:/source \
  -v /home/node/.openclaw:/dest \
  alpine cp -a /source/. /dest/

# Fix ownership
sudo chown -R 1000:1000 /home/node/.openclaw
```

---

## Lessons Learned

| Lesson                                         | Explanation                                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Named volumes isolate data**                 | Docker named volumes live in `/var/lib/docker/volumes/` and are not directly accessible from the host. Use bind mounts when multiple services need to share files.     |
| **UID matters, not username**                  | The `node` user inside a container has UID 1000. On the host, UID 1000 might be `ubuntu`. Always use numeric UIDs (`chown 1000:1000`) for cross-container permissions. |
| **`:ro` prevents writes**                      | Read-only mounts (`:ro`) are good for security but will silently fail on write operations.                                                                             |
| **Running commands as root changes ownership** | Using `sudo` inside containers or copying files as root will create root-owned files. Use `-u node` flag or fix permissions after.                                     |
| **Auto-deploy can cause issues**               | Pushing changes triggers auto-deploy before you can prepare the server (create directories, copy data).                                                                |

---

## Recovery Instructions

If you encounter this issue again, follow these steps:

### Step 1: Create Host Directories

```bash
sudo mkdir -p /home/node/.openclaw /home/node/.moltbot /home/node/.clawdbot /home/node/clawd
```

### Step 2: Copy Data from Docker Volumes (if they exist)

```bash
# List available volumes
sudo docker volume ls | grep moltbot

# Copy openclaw config
sudo docker run --rm \
  -v <VOLUME_NAME>_moltbot-openclaw:/source \
  -v /home/node/.openclaw:/dest \
  alpine cp -a /source/. /dest/
```

### Step 3: Fix Permissions

```bash
sudo chown -R 1000:1000 /home/node/.openclaw /home/node/.moltbot /home/node/.clawdbot /home/node/clawd
```

### Step 4: Restart Containers

```bash
# Restart Moltbot
sudo docker restart $(sudo docker ps -qf "name=moltbot")

# Check logs for errors
sudo docker logs $(sudo docker ps -qf "name=moltbot") --tail 30
```

### Step 5: Verify No Permission Errors

Look for successful startup messages like:

```
[gateway] agent model: minimax/MiniMax-M2.1-lightning
[gateway] listening on ws://0.0.0.0:18789
```

If you still see `EACCES` errors, run Step 3 again.

---

## Quick Reference Commands

| Task                 | Command                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Fix permissions      | `sudo chown -R 1000:1000 /home/node/.openclaw`                                                        |
| Restart Moltbot      | `sudo docker restart $(sudo docker ps -qf "name=moltbot")`                                            |
| View Moltbot logs    | `sudo docker logs $(sudo docker ps -qf "name=moltbot") --tail 50`                                     |
| Check file ownership | `ls -la /home/node/.openclaw/openclaw.json`                                                           |
| Run solobot safely   | `sudo docker exec -it -u node $(sudo docker ps -qf "name=moltbot") node /app/dist/index.js configure` |

---

## Files Changed

| File                                           | Change                       |
| ---------------------------------------------- | ---------------------------- |
| `SoLoBot-Server/docker-compose.coolify.yml`    | Named volumes → Bind mounts  |
| `SoLoBot-Dashboard/docker-compose.coolify.yml` | Read-only → Read-write mount |

---

## Simple Explanation

**What happened:** The Dashboard and Moltbot were looking at _different copies_
of the same config file. Moltbot kept its files inside Docker's hidden storage
area, while the Dashboard tried to read from a folder on the server. They never
saw each other's changes.

**How we fixed it:** We told both services to use the _same folder_ on the
server (`/home/node/.openclaw`). Then we copied all the existing settings from
Docker's hidden storage into that shared folder.

**Why it kept breaking:** The config file was owned by "root" (the admin user),
but Moltbot runs as a regular user called "node". It's like having a locked
filing cabinet—Moltbot had the key to its own drawer, but root's drawer was
locked to everyone else.

**The permanent fix:** We changed the file ownership so Moltbot can always read
and write its own config, and both services now share the same location.
