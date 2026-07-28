---
name: xbsl-en-deploy
description: >
  Deploy a 1C:Enterprise.Element project to a cloud application (1cmycloud) via the
  management Console API. Use when asked to deploy, publish, update, restart, or check
  the status of an Element application, or to push the current sources to a cloud app.
  Covers the two deploy paths (build-from-sources and platform-side git pull), the
  environment/credentials needed, and the operational gotchas learned in production
  (which project directory to point at, local-library resolution, version numbering,
  waiting for Running, surfacing apply errors). This is a clean-room process guide —
  bring your own build/upload script or the platform's git integration.
---

# Deploying an Element project to a cloud application

A practical, tool-agnostic guide to shipping an Element (xBSL) project to a cloud
application via the management Console API. It documents the **flow and the
gotchas**; it deliberately does not ship a build tool — use the platform's git
integration, or your own script against the official Console API.

> Get the exact Console API endpoint paths and request/response fields from the
> official 1C:Element management API documentation. This guide covers the *sequence*
> and the *operational lessons*, not endpoint strings.

## Two deploy paths

**Path A — platform-side git pull (no local build).** The application is bound to a
git branch; you ask the platform to sync that branch. The platform pulls and rebuilds
itself. Simplest for CI: commit, then trigger a branch sync, then poll status. No
`.xasm` is produced locally.

**Path B — build from local sources.** You package the project into a build image
(`.xasm` for an application, `.xlib` for a library), upload it, switch the application
to that image, and wait. Use this when you deploy from a working copy that is not the
app's bound git branch (e.g. a local-only repo).

Both paths end the same way: **poll the application status until it reports `Running`,
then check for apply errors** (see below).

## Credentials & environment

Console API access uses a client id / secret pair issued in the management console.
Keep them in a `.env` (git-ignored) — see [`scripts/.env.sample`](scripts/.env.sample):

- base URL of the console API
- client id / client secret
- project id (needed to build/list builds)
- application id (the target app)
- for Path A: the platform branch id
- optional: space id, branch name / commit / message metadata for the build

Never commit real credentials. Never materialize an application user's exchange
secret to disk as part of deploy — that belongs in the app's secure storage.

## Path B step sequence

1. **Determine the next version.** List the project's builds, take the last
   `{base}-{N}` and produce `{base}-{N+1}`. Auto-incrementing avoids version clashes.
2. **Build the image.** Package the project files into a build archive with its
   assembly descriptor. See "Local library resolution" — the app's dependent
   libraries in the same repo must go into the *same* image.
3. **Upload the image**, receive an image id.
4. **Switch the application** to that image id (an update/apply operation).
5. **Poll** the application until status is `Running` (it passes through `Updating`).
6. **Surface apply errors** — a `Running` status does **not** mean the project
   applied cleanly. Read the apply/operation result and fail loudly on messages like
   *"error applying project to application"* (bad YAML indentation, unknown property,
   etc.). Treat any such message as a failed deploy even though the app is up.

## Operational gotchas (learned in production)

- **Point the build at the application directory, not the workspace root.** The
  project directory must be the one that directly contains the app's `Project.yaml`
  (`Проект.yaml`). A workspace folder holding several projects side by side is not a
  valid build root.
- **Local library resolution.** If the app's `Project.yaml` lists libraries
  (`Libraries:` / `Библиотеки:`) that live in the same repository, their files must be
  included in the same build image — otherwise the platform cannot resolve the
  imports (e.g. `import Vendor::SomeLib::Core`). Collect each `Vendor/Name` library
  folder found under the repo and pack it alongside the application.
- **Version numbers are `{base}-{counter}`.** Derive base from the project file and
  the counter from the last build + 1; let a `--version` override win when given.
- **YAML apply errors are your linter.** A colon inside a form-column expression
  (a ternary `? … : …`) must be quoted, or apply fails with *"invalid indentation /
  value not set / unknown property"*. The deploy's apply-error output is often the
  fastest way to catch these — read it, don't just check for `Running`.
- **Multiple apps from one project.** To update a different application of the same
  project, change only the target application id; keep the project id. Do not deploy
  to an app that was handed off for testing.
- **Dump before deploy** if you rely on snapshots — the platform keeps history, but a
  local dump is cheap insurance before a switch.

## Status / restart / stop

The same Console API exposes application lifecycle operations (status, start, stop,
delete, and accept-changes / merge for the platform's internal branches). Poll status
the same way; most operations are asynchronous and pass through a transient state
before settling.
