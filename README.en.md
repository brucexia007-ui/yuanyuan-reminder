# Yuanyuan Reminder

An offline Windows desktop pet that helps with hydration, tasks, focus sessions, breaks, and healthy movement — while still acting like a playful cat.

[Download 1.5.35 Preview 1](../../releases/tag/yuanyuan-1.5.35-preview.1) · [Customize your pet](docs/CUSTOMIZE_YOUR_PET.md) · [中文](README.md)

![Yuanyuan showing a prominent reminder](docs/images/yuanyuan-alert.jpg)

## Current source: 1.5.35

One Yuanyuan application now combines reminders, learning, and independently imported pet packages. Switching pets preserves shared learning data and settings.

- Answer feedback and the next-question control fit on one blackboard, without scrolling or overlap with the pet.
- Yuanyuan stays still while you read. After one minute without an answer, she makes at most one brief curious gesture per question. Answer feedback still animates.
- The wand interaction restores the original eight-direction reach, swipe, and return poses.

Local verification, Rust tests, and the production build passed. Version 1.5.35 is installed on the maintainer's computer, and the user reported normal behavior after manual review. The user removed the new 24-hour observation from this round; no completed endurance run is claimed. Stable release acceptance remains `PENDING`. The [1.5.35 Preview 1 installer](../../releases/tag/yuanyuan-1.5.35-preview.1) is now available as a pre-release, not a stable release. See the [source and installer handoff](docs/release/UNIFIED_1_5_35_GITHUB_HANDOFF.md) and [changelog](CHANGELOG.md).

## What Yuanyuan does

- Shows prominent task, water, and movement reminders without covering her face.
- Stays calmly seated or lying down during focus sessions.
- Jumps happily when it is time to move after extended computer use.
- Eats food, drinks water, follows a treat, reaches for a wand, nudges the pointer, and fetches a thrown ball.
- Grooms, stretches, yawns, meows, rolls over, sleeps, breathes, and wakes up during idle time.
- Stores reminders, history, focus sessions, hydration, and settings locally in SQLite.
- Offers desktop English and knowledge review, multiple-choice and recall cards, pause/resume, mistake practice, and learning records.
- Imports CSV, native JSON, and generic learning packs, with preview, progress, cancellation, and export. Personal learning content is not bundled.
- Runs without Codex, Node.js, Rust, Python, an account, or a cloud service.

## Download

As of September 22, 2026, the latest stable [Release](../../releases/latest) is **v1.3.2**, while this source is **1.5.35**. The separate Jiaojiao preview is not an update to the unified Yuanyuan application. Version 1.5.35 is available as [Preview 1](../../releases/tag/yuanyuan-1.5.35-preview.1); it is not yet a stable release. You can also build it from source below.

Choose the Windows x64 installer or portable executable listed on the relevant Release and verify its `SHA256SUMS.txt`. The project is unsigned, so Windows SmartScreen may show an unknown-publisher warning. Back up data before upgrading; reverting to an older executable requires its matching pre-upgrade data backup.

The same pre-release now includes the separate [Jiaojiao pet package](../../releases/download/yuanyuan-1.5.35-preview.1/jiaojiao.yuanyuan-pet). Import it through **Settings → My Pet** without extracting it, then switch to Jiaojiao. The installer still defaults to Yuanyuan. Keep the original license and [supplemental permission](docs/pet-packs/JIAOJIAO_ASSET_LICENSE_ADDENDUM.md); Jiaojiao uses the same personal, non-commercial asset terms as Yuanyuan.

## A calmer learning board

![Learning board in 1.5.35, using isolated demo data](docs/images/learning-board-v1.5.35.png)

Start a review from the Learning page and answer with the mouse or number keys 1–4. After answering, the board keeps your selection and the correct option visible alongside the conclusion. Mistakes wait for you to continue. A paused session retains the current question.

## Build from source

Requirements: Node.js 22+, Rust stable, Visual C++ Build Tools, and WebView2 Runtime.

```powershell
npm.cmd ci
npm.cmd run verify
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm.cmd run tauri build
```

Merging source into `main` runs CI but does not publish a Release. Stable tags use a separate acceptance workflow; the historical V1/V2 contracts and uncompleted checks remain documented. This round does not restart a 24-hour observation.

## Make it your pet


For animation or display problems after import, give your agent the original `.yuanyuan-pet`, a problem description and optional recordings, together with the [pet repair prompt](AI_PET_REPAIR_PROMPT.md) and [offline repair workflow](docs/PET_REPAIR_WORKFLOW.md). It repairs a copy and provides a comparison. Import the result as a new shape through My Pet; keep the old shape to switch back. Nicknames are not inherited automatically. First-time creators also deliver a separate [private source project](pet-template/source-project.template.md), excluding original photos and application data by default.

The app cannot generate a pet directly from uploaded photos. Give 3–8 photos you have the right to use, the pet's name and personality, and the [AI coding prompt](AI_CUSTOMIZATION_PROMPT.md) to a tool or asset creator that supports reference-image generation/editing and local file handling.

The workflow is **provide photos → approve the master image → generate and review animations → import the pet package**. Photographic realism is the default; another style must be explicitly requested. Review a private photo comparison and a desktop-size preview before animation generation. Silence is not approval, and replacing the approved master requires renewed approval. The creator checks idle, head-turn and walking samples before producing the full set.

Preserve the pet's actual age, facial anatomy, body proportions, fur and markings. Yuanyuan and Jiaojiao illustrate texture and restrained motion, not a replacement identity. Avoid enlarged eyes or toy-like proportions while retaining naturally round eyes or short muzzles present in the photos. Reference-image support and visual review determine the result; successful packaging is not proof of realism or native playback acceptance.

Follow the [customization guide](docs/CUSTOMIZE_YOUR_PET.md) and [pet pack specification](docs/PET_PACK_SPEC.md). The default deliverable is a `.yuanyuan-pet` file imported through **Settings → My Pet**; keep the application identity and existing data. Original photos and completed [review records](pet-template/realism-review.template.md) remain in an ignored private workspace.

The application code is [MIT licensed](LICENSE). Yuanyuan's photographs and derived visual assets have a separate [personal, non-commercial asset license](ASSETS_LICENSE.md). Forks are encouraged to replace them with their own pet imagery.
