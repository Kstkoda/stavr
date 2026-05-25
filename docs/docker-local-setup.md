# Local Docker Setup — stavR Bombardment Rig

> **Purpose.** Stand up a local Docker host on this Windows machine so the
> bombardment chaos rig (three stavR daemons running in Docker) can be brought
> up and debugged **locally**, in seconds, instead of through slow CI round-trips.
> This guide covers install, the Phase 0 rig bring-up, and a full uninstall path.

---

## Overview

Five steps. The first three are one-time machine setup; the last two are the
actual rig bring-up (BOM Phase 0).

1. **Install WSL2 + Ubuntu** — the Linux backend Docker needs.
2. **Install Docker Desktop** — the Docker engine, running on the WSL2 backend.
3. **Verify Docker works** — a one-line sanity check.
4. **Build the `stavr:ci` image + bring the rig up** — three daemons in Docker.
5. **Confirm the rig is healthy** — establishes the fast debug loop.

A full **Uninstall / revert** section is at the end — everything here is
reversible.

Wall time: ~20–30 minutes, most of it downloads and the first image build.
One reboot (after Step 1), possibly a second (after Step 2).

---

## Machine check (already confirmed)

| Item | Status |
|---|---|
| OS | Windows 11 Pro, build 26200 — modern, full WSL2 support |
| CPU / RAM | Intel i9-14900K, 64 GB — far more than enough |
| Virtualization | On — VBS shows "Running", which requires VT-x enabled in BIOS |
| WSL2 | Not yet installed — Step 1 installs it |
| Docker | Not installed — Step 2 installs it |

No BIOS changes are needed. Docker Desktop coexists fine with the
Virtualization-based Security / Hyper-V already running on this machine.

---

## Step 1 — Install WSL2 + Ubuntu

WSL2 (Windows Subsystem for Linux 2) is a lightweight real Linux VM. Docker
Desktop runs its engine inside it.

1. Open **PowerShell as Administrator** — right-click the Start button →
   **Terminal (Admin)**.

2. Run:

   ```powershell
   wsl --install
   ```

   This enables two Windows features ("Virtual Machine Platform" and "Windows
   Subsystem for Linux"), downloads the WSL2 kernel, and installs Ubuntu (the
   default distro).

3. **Reboot** when it asks you to.

4. After the reboot, an **Ubuntu window opens by itself** and asks you to
   create a Linux user:
   - **Username** — lowercase, no spaces (e.g. `kenneth`).
   - **Password** — pick one you'll remember; you'll type it for `sudo` inside
     Linux. It won't echo characters as you type — that's normal.

5. Verify. Open a normal PowerShell window and run:

   ```powershell
   wsl -l -v
   ```

   **Expected:** a line for `Ubuntu` with `VERSION` = `2`.

---

## Step 2 — Install Docker Desktop

1. **Download the installer.** In a browser, go to:

   <https://www.docker.com/products/docker-desktop/>

   Click **"Download for Windows – AMD64"**. You'll get `Docker Desktop
   Installer.exe` (~700 MB) in your Downloads folder.

   *(PowerShell alternative — same file:)*

   ```powershell
   Invoke-WebRequest -Uri "https://desktop.docker.com/win/main/amd64/Docker Desktop Installer.exe" -OutFile "$env:USERPROFILE\Downloads\DockerDesktopInstaller.exe"
   ```

2. **Run the installer.** Double-click it (approve the admin / UAC prompt). On
   the configuration screen, leave **"Use WSL 2 instead of Hyper-V"** checked —
   that is the default and exactly what we want.

3. Let it finish. It will ask you to **close and restart** (or log out and back
   in) — do that.

4. **Launch Docker Desktop** from the Start menu. On first run:
   - Accept the service agreement.
   - If it asks you to sign in or create a Docker account — **skip it**. No
     account is needed to use Docker.
   - Skip the tutorial if it offers one.

5. Wait for the **whale icon in the system tray to stop animating**, and the
   Docker Desktop window's bottom-left corner to show a green **"Engine
   running"**.

   **Expected end state:** green "Engine running", Docker Desktop sitting
   quietly in the tray. With 64 GB of RAM the default resource limits are fine —
   no tuning needed.

---

## Step 3 — Verify Docker works

Open a **new** PowerShell window (a fresh one, so it picks up the updated PATH)
and run:

```powershell
docker --version
docker compose version
docker run --rm hello-world
```

**Expected:**
- `docker --version` → `Docker version 2x.x.x …`
- `docker compose version` → `Docker Compose version v2.x.x`
- `docker run --rm hello-world` → a paragraph beginning **"Hello from
  Docker!"**. The `--rm` flag auto-removes the throwaway container.

If all three succeed, the Docker host is ready.

---

## Step 4 — Build the image and bring the rig up

This is **BOM Phase 0 — local rig bring-up**. Nothing is being debugged yet;
this just gets the three-daemon topology running. None of these commands change
any files, so they run on `main` (the bombardment rig is on `main` after
PR #82). The actual chaos-slice fixes later go on a `feat/bombardment-chaos-green`
branch — see `proposed/bombardment-chaos-debug-bom.md`.

1. **Confirm your checkout has the merged rig.** In PowerShell:

   ```powershell
   cd C:\dev\cowire
   git symbolic-ref --short HEAD
   git status --short
   Test-Path .\bombardment\compose\docker-compose.yml
   ```

   **Expected:** branch is `main` (if not, `git checkout main`), and
   `Test-Path` prints `True`. If `main` is behind, `git pull` to update.

2. **Build the image.** From the repo root (`C:\dev\cowire`):

   ```powershell
   docker build -t stavr:ci .
   ```

   This runs the top-level `Dockerfile` and packages the stavR daemon into an
   image tagged `stavr:ci` — the same tag the compose files and CI expect. The
   **first build takes a few minutes** (it pulls a Node base image and runs
   `npm install` + `npm run build` inside). Later rebuilds are much faster
   thanks to layer caching.

   **Expected:** ends with `naming to docker.io/library/stavr:ci` or
   `writing image … done`.

3. **Bring the rig up.** Move into the compose directory and start it:

   ```powershell
   cd C:\dev\cowire\bombardment\compose
   docker compose up -d
   ```

   `-d` runs it detached (in the background). This starts three containers:

   | Container | Docker network | Host port |
   |---|---|---|
   | `stavr-peer-a` | `site_a` (172.30.10.0/24) | `localhost:17777` |
   | `stavr-peer-b` | `site_b` (172.30.20.0/24) | `localhost:17778` |
   | `stavr-hub` | both networks (multi-homed) | `localhost:17779` |

   **Expected:** `docker compose up` prints `Created` / `Started` for all
   three containers and the two networks.

> **Note on `chaos.yml`.** The BOM writes Phase 0 as `docker compose -f
> docker-compose.yml -f chaos.yml up -d`. Including `chaos.yml` also starts the
> `pumba-kill-peer-a` sidecar, which SIGKILLs peer-a once on startup (it
> self-heals via `restart: unless-stopped`). For a clean "is everything
> healthy" **baseline**, bring up the **base topology only** as above. Add the
> chaos overlay later, when actually running the kill slice in Phase 1.

---

## Step 5 — Confirm the rig is healthy

1. Check container state:

   ```powershell
   docker compose ps
   ```

   **Expected:** `stavr-peer-a`, `stavr-peer-b`, `stavr-hub` all `Up` (and
   `(healthy)` once their healthchecks settle — give it ~30–60 s).

2. Hit each daemon's liveness endpoint:

   ```powershell
   curl.exe http://localhost:17777/healthz
   curl.exe http://localhost:17778/healthz
   curl.exe http://localhost:17779/healthz
   ```

   **Expected:** each returns HTTP 200 with a small OK body. *(Use `curl.exe`,
   not bare `curl` — in PowerShell `curl` is an alias for `Invoke-WebRequest`.)*

3. Check federation state:

   ```powershell
   curl.exe http://localhost:17777/api/federation/peers
   ```

   **Expected:** a JSON object listing peers. Cross-subnet peers (peer-a ↔
   peer-b) staying `offline` is **correct** — the two site networks are
   deliberately disjoint; only the hub bridges them.

4. If anything looks wrong, read a container's logs:

   ```powershell
   docker compose logs peer-a
   docker compose logs hub
   ```

**Phase 0 is "done"** one notch beyond this: the federation oracles and the
Phase 3c pumba-slice passing locally. Their runner lives under `bombardment/` —
check `bombardment/README.md` for the exact invocation, or confirm it together
when you reach this point.

---

## Troubleshooting

**`wsl --install` reports nothing happened / feature already enabled.**
Run `wsl --update`, then `wsl --install` again. Reboot.

**Docker Desktop won't start — "WSL 2 is not installed" or similar.**
Run `wsl --update` in PowerShell, confirm `wsl -l -v` shows a distro at
`VERSION 2`, then relaunch Docker Desktop.

**Docker Desktop stuck on "Starting…".**
Right-click the tray whale → **Quit Docker Desktop**, then relaunch. If it
persists, restart Windows.

**`docker build` fails mid-way (network / npm error).**
Just re-run it — the layer cache resumes from the last good step. Confirm
Docker Desktop shows "Engine running" and the machine has internet.

**Port already in use (17777 / 17778 / 17779).**
Something else is bound to that port. Find it:

```powershell
netstat -ano | findstr "1777"
```

**`curl` behaves oddly in PowerShell.**
Always use `curl.exe` (the real curl). Bare `curl` is `Invoke-WebRequest`.

---

## Uninstall / revert

Everything below is reversible. Pick the depth you need.

### Option A — Quick reset (keep Docker, wipe just the rig)

Use this to start the rig over from scratch without uninstalling anything.

```powershell
cd C:\dev\cowire\bombardment\compose
docker compose down -v
docker rmi stavr:ci
```

- `docker compose down -v` stops and removes the three containers, the two
  networks, **and** the named volumes (`stavr_peer_a_home`, `stavr_peer_b_home`,
  `stavr_hub_home`).
- `docker rmi stavr:ci` removes the built image.

To rebuild later, just redo Step 4. *(If you brought the rig up with the chaos
overlay, tear it down the same way: `docker compose -f docker-compose.yml -f
chaos.yml down -v`.)*

### Option B — Full uninstall (reverse order of install)

**B1 — Tear down the rig** (as in Option A):

```powershell
cd C:\dev\cowire\bombardment\compose
docker compose down -v
```

**B2 — Reclaim all Docker disk** (optional, removes every unused image /
container / network / volume — aggressive):

```powershell
docker system prune -a --volumes
```

**B3 — Uninstall Docker Desktop.**
Windows **Settings → Apps → Installed apps → Docker Desktop → Uninstall**.
This also removes Docker's own `docker-desktop` WSL distro and the engine.
Leftover config folders may remain and can be deleted manually if you want a
spotless removal: `%APPDATA%\Docker`, `%LOCALAPPDATA%\Docker`,
`%ProgramData%\Docker`.

**B4 — Remove the Ubuntu WSL distro** (optional). First check its exact name:

```powershell
wsl -l -v
```

Then unregister it:

```powershell
wsl --unregister Ubuntu
```

> ⚠️ **`wsl --unregister` permanently deletes that distro and everything
> stored in its Linux filesystem.** It is not reversible. Only do this if you
> have nothing you care about inside Ubuntu. The Ubuntu *app* can then also be
> removed via Settings → Apps → Ubuntu → Uninstall.

If Docker Desktop left a `docker-desktop` distro behind after B3, remove it the
same way: `wsl --unregister docker-desktop`.

**B5 — Disable WSL2 entirely** (optional — the deepest revert). Only if you
want WSL gone from Windows completely. From an **Administrator** PowerShell:

```powershell
dism.exe /online /disable-feature /featurename:Microsoft-Windows-Subsystem-Linux /norestart
dism.exe /online /disable-feature /featurename:VirtualMachinePlatform /norestart
```

Then reboot. To bring WSL2 back later, re-run `wsl --install`.

> Most people stop at **B3** (uninstall Docker Desktop) or **B4** (also drop
> Ubuntu). B5 is rarely needed — leaving WSL2 installed costs nothing when
> idle.

### What's reversible

| Action | Reversible? |
|---|---|
| `docker compose down -v` | Yes — `up -d` again (volumes start fresh) |
| `docker rmi` / `docker system prune` | Yes — rebuild the image |
| Uninstall Docker Desktop | Yes — reinstall |
| `wsl --unregister <distro>` | **No** — distro data is destroyed |
| Disable WSL Windows features | Yes — `wsl --install` again + reboot |

---

## Reference

**Repo root:** `C:\dev\cowire` (branch `main`)
**Compose directory:** `C:\dev\cowire\bombardment\compose`
**Follow-up BOM:** `proposed/bombardment-chaos-debug-bom.md`

| Component | Value |
|---|---|
| Image tag | `stavr:ci` |
| Containers | `stavr-peer-a`, `stavr-peer-b`, `stavr-hub` |
| Networks | `stavr_site_a` (172.30.10.0/24), `stavr_site_b` (172.30.20.0/24) |
| Volumes | `stavr_peer_a_home`, `stavr_peer_b_home`, `stavr_hub_home` |
| Host ports | peer-a `17777`, peer-b `17778`, hub `17779` |
| Endpoints | `/healthz` (liveness), `/api/federation/peers` (federation state) |

**Common commands**

```powershell
docker compose up -d                 # start the rig
docker compose ps                    # container status
docker compose logs -f peer-a        # follow a daemon's logs
docker compose restart peer-a        # restart one daemon
docker compose down                  # stop + remove (keeps volumes)
docker compose down -v               # stop + remove + wipe volumes
docker build -t stavr:ci .           # rebuild the image (from repo root)
```
