# Coding Agent Guide

This repository is an offline Windows desktop pet and reminder application built with React, TypeScript, Rust, Tauri 2, and SQLite.

## Read first

Before changing pet visuals or branding, read:

- `docs/CUSTOMIZE_YOUR_PET.md`
- `docs/PET_PACK_SPEC.md`
- `ASSETS_LICENSE.md`
- `AI_CUSTOMIZATION_PROMPT.md`

## Product invariants

- The installed application must run without Codex, Kimi Code, Node.js, Rust, Python, an account, telemetry, or a cloud service.
- User tasks, history, hydration, focus sessions, care counts, and settings stay local.
- Water reminders take priority over movement reminders when they overlap.
- Focus mode keeps the pet calm; strong alerts and user interactions must cleanly restore the prior state.
- Switching interactions must remove the previous treat, wand, petting zone, or ball state.
- Do not bypass Windows authentication when ending a locked break session.

## Pet visual invariants

- Preserve the same pet identity across every row: color, face, eyes, markings, body proportions, and style.
- The standard atlas is 8×11 with 192×208 cells. Rows 9–10 are 16 clockwise look directions.
- Do not fake animation by shaking, rotating, or scaling one still image.
- Generate or repair a complete coherent action row, not an isolated replacement frame from a different generation.
- Keep transparent backgrounds and avoid text, scenery, detached effects, shadows, glows, speed lines, cropping, and cross-cell overlap.
- The app also requires a 3-row sleep atlas and a 21-row life/interaction atlas.

## Source map

- `src/pet/`: pet state machine, renderer, pointer interactions, and animation manifest fallback.
- `src/panel/`: reminders, focus, care, history, and settings UI.
- `src/lib/backend.ts`: Tauri bridge and browser demo data.
- `src-tauri/src/`: scheduler, SQLite repository, notifications, Windows integration, and commands.
- `public/assets/pet/`: runtime pet pack.
- `scripts/`: deterministic pet atlas and validation utilities.

## Required validation

Run before reporting completion:

```powershell
npm.cmd run verify
cd src-tauri
cargo test
cd ..
npm.cmd run tauri build
```

For UI changes, inspect the panel and pet at representative Windows scaling values. For pet changes, inspect real animated playback as well as static contact sheets.

## Repository hygiene

- Do not commit `release/`, `work/`, `dist/`, `node_modules/`, `src-tauri/target/`, logs, original private photos, or failed generations.
- Put downloadable executables in GitHub Releases.
- Never add secrets, personal absolute paths, or user data from `%LOCALAPPDATA%`.
- Code is MIT-licensed. Yuanyuan visual assets have separate terms in `ASSETS_LICENSE.md`; forks should replace them with their own licensed pet assets.
