# Astra Client

A Minecraft launcher: Microsoft sign in, every version, all four mod loaders, a built-in
mod and shader browser, live capes and friends you can drop straight into.

## Download

Grab the installer from [Releases](https://github.com/justthatguypal/ASTRAClient-/releases/latest).

- **Installer** - per-user, no administrator prompt
- **Portable zip** - if you would rather not run an installer

## What is in this repo

| Path | What it is |
| --- | --- |
| `update.json` | The manifest the launcher polls for updates |
| `app/` | The launcher's own files, hashed in the manifest |
| `docs/` | The website (GitHub Pages serves this) |

Updates are delta based: the launcher compares hashes and downloads only what changed,
so a normal update is a few dozen kilobytes rather than reinstalling.
