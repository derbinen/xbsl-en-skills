# xbsl-en-skills

English · [Русский](README.ru.md)

Claude Code / agent **skills for 1C:Enterprise.Element (xBSL)** projects whose
development language is **English** (`DevelopmentLanguage: English`).

Most existing Element skill sets generate Russian keywords and Russian identifiers.
These skills are the opposite: every keyword, type name and identifier is
**English by default** (`method`, `val`, `throw`, `StandardTableColumn`, `Colors.Red`,
…), matching a project configured with English as its development language.

Every pattern here was written for, and verified by deploying to, a real
production Element application (platform 9.2, then 10.0) — not reconstructed from documentation.

## Skills

| Skill | What it does |
|-------|--------------|
| [`xbsl-en-deploy`](xbsl-en-deploy/) | Deploying an Element project to the cloud (1cmycloud) via the console API v2.1: a dependency-free Node.js script packs the sources, lets the console build and number them, updates the application, follows the update task and reports the platform's apply error — plus the operational gotchas learned in production. |

## Install

Copy (or symlink) the skill folders into a Claude Code skills directory:

```bash
# per-project
cp -r xbsl-en-deploy  /path/to/project/.claude/skills/

# or globally for the user
cp -r xbsl-en-deploy  ~/.claude/skills/
```

A skill is just a folder with a `SKILL.md` (YAML front-matter + instructions) and
optional `references/` and `scripts/`. Nothing is compiled. The deploy script needs
Node.js 20.12 or newer and no packages.

## Scope

- **Target:** 1C:Enterprise.Element (xBSL) with English as the development language. The
  patterns come from an application on platform 9.2 and then 10.0; the deploy script is
  verified on 10.0 with the console API v2.1.
- **Not** for classic 1C:Enterprise (BSL, `Procedure`/`&AtServer`/DCS/config XML).
  That is a different language and platform.
- The authoritative source for API/type names is the Element documentation. These
  skills encode *patterns*, not a full API reference.

## License

MIT — see [LICENSE](LICENSE).
