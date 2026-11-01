---
name: xbsl-en-deploy
description: >
  Deploy a 1C:Enterprise.Element project to a cloud application (1cmycloud) via the
  management console API (v2.1). Use when asked to deploy, publish, update, restart, or
  check the status of an Element application, or to push the current sources to a cloud
  app. Ships a dependency-free Node.js script: it packs the sources, lets the console build
  and number them, updates the application, follows the update task and reports the
  platform's apply error. Also documents the credentials and the operational gotchas
  learned in production.
---

# Deploying an Element project to a cloud application

A practical guide to shipping an Element (xBSL) project to a cloud application via the
management console API, with a ready script for it: `scripts/deploy.mjs`.

## Running the script

Node.js 20.12 or newer, no packages to install. From the folder that holds the `.env`:

```bash
node <skill>/scripts/deploy.mjs --project-dir <folder with Project.yaml>

# pack only, send nothing (with --save the archive is kept for a look)
node <skill>/scripts/deploy.mjs --project-dir <folder with Project.yaml> --dry-run --save sources.zip
```

Options: `--env <file>` (default `./.env`), `--app-id` and `--project-id` (override the
`.env` values), `--message <text>` (a comment kept with the build; default: the subject of
the last git commit), `--save <file>` (keep the archive that was sent), `--help`.

**Read the output to the end.** `Deployed <build>` is printed only after the update task
of the platform completed. When it failed, the script prints the platform's own message
(file, line, reason) and exits with code 1 — the application keeps running its previous
build.

The scripts: `deploy.mjs` (the command), `sources.mjs` (packing the sources),
`console.mjs` (sign-in and the console API calls); `package.json` states the Node.js version
they need. Every call to the console has a time limit, so a console that does not answer
ends the deploy with an error instead of hanging.

## How the deploy goes

1. **Pack the sources.** A plain ZIP, the way the IDE exports a project: the project
   folder and every library project of the same repository, under their
   `{Vendor}/{Name}/…` paths. No build descriptor is written and no version is computed.
2. **Add the archive to the console project** (`POST /console/api/v2.1/projects/{id}/assemblies`).
   The console builds it itself and answers with the builds it made, each with its
   `assembly-version` — the next number of the project, given by the platform.
3. **Update the application to that build**
   (`POST /console/api/v2.1/applications/{id}/project/update` with
   `sources: [{project-id, assembly-version}]`). The answer carries the `current-task`
   the platform started for it.
4. **Follow that task** (`GET /console/api/v2.1/tasks/application-tasks/{taskId}`) until it
   is `Completed` or `Failed`. A failed task holds the reason in `error-message`.
5. **Make sure the application runs** — start it if the update left it stopped.

The application's status alone is not a result: after a failed update it is still
`Running`, on the old build. The task is what tells.

## Credentials & environment

Console API access uses a client id / secret pair issued in the management console
(profile → access keys). Keep them in a `.env` (git-ignored) — see
[`scripts/.env.sample`](scripts/.env.sample); the script reads it from the current folder
or from `--env`:

- `ELEMENT_BASE_URL` — the console host
- `ELEMENT_CLIENT_ID`, `ELEMENT_CLIENT_SECRET` — the access key
- `ELEMENT_PROJECT_ID` — the console project the builds go to
- `ELEMENT_APP_ID` — the application to update

The token (`POST /console/sys/token`, Basic auth, `grant_type=client_credentials`) is the
`id_token` of the answer and lives for an hour; on a 401 the script signs in again. Never
commit real credentials.

## Operational gotchas (learned in production)

- **Point the script at the application directory, not the workspace root.** The
  project directory must be the one that directly contains the app's `Project.yaml`
  (`Проект.yaml`); the repository is the folder two levels up.
- **Libraries of the same repository travel with the application.** The platform resolves
  `import Vendor::SomeLib::Core` from the archive, so every library project next to the
  application is packed with it.
- **YAML apply errors are your linter.** A colon inside a form-column expression
  (a ternary `? … : …`) must be quoted, or apply fails with *"invalid indentation /
  value not set / unknown property"*. The task's error message names the file and line.
- **Multiple apps from one project.** To update a different application of the same
  project, change only the target application id; keep the project id. Do not deploy
  to an app that was handed off for testing.
- **Dump before deploy** if you rely on snapshots — the platform keeps history, but a
  local dump is cheap insurance before a switch.
- **A failed apply leaves the previous build running.** The update is refused as a whole;
  only the task tells it failed.
- **An enumeration value still stored in data cannot be removed.** Apply fails with
  *"cannot delete enumeration items … data in the table … uses these values"*. Change the
  stored values first (e.g. re-pick the setting in the app), then deploy the removal.
- **Doubled apostrophes are not accepted in YAML strings.** A single-quoted scalar with
  `''` inside (`'the users'' browsers'`) fails apply with an unhelpful *"invalid value for
  type Map … value not set"*. Reword the text or use double quotes.
- **A property given twice in one component** (two `HorizontalStretch:` lines, easy to
  produce when scripting YAML edits) is an apply error, not a build error — the archive
  is accepted and built fine.
- **An unspecific apply error** (*"unknown error INIT_PREPARE_APPLY_PROJECT_TO_APP"*):
  run the deploy once more — the second attempt reports the real message with the file
  and line.
- **Every deploy is a new build.** A failed one stays in the project's builds; it is
  harmless and can be deleted in the console.

## Status / restart / stop

The same console API exposes the application lifecycle: `GET …/applications/{id}/status`,
`POST …/status/start`, `POST …/status/stop` and more. Most operations are asynchronous:
the answer carries a `current-task` to follow, as the deploy does.
