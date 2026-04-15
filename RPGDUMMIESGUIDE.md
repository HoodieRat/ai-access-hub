# RPG Dummies Guide (Hermes) - Full Step-by-Step

This guide shows exactly how to go from an already-open Hermes command line to a playable retro RPG project.

It includes:
- Exact terminal commands
- Exact prompts to paste into Hermes
- A clean build order that avoids chaos

---

## 0) Assumptions

You already have:
- Hermes working in your terminal
- Your normal model/provider setup already configured
- Permission to create a new project folder

This guide does **not** change your backend/provider/model architecture.

---

## 1) Start From Your Opened Hermes Command Line

From your open terminal, run these checks first:

```bash
hermes --version
hermes skills list
```

If Hermes is not found, activate the environment you normally use for Hermes, then retry.

---

## 2) Install the RPG Skills You Need

Run these commands in the same terminal:

```bash
hermes skills install skills-sh/develop-web-game --yes
hermes skills install skills-sh/chongdashu/phaserjs-tinyswords/phaser-gamedev --yes
hermes skills install skills-sh/chongdashu/phaserjs-tinyswords/tinyswords-tilemap --yes
hermes skills install skills-sh/game-designer --yes
hermes skills install skills-sh/game-assets --yes
```

Verify they are present:

```bash
hermes skills list
```

You should see at least:
- develop-web-game
- phaser-gamedev
- tinyswords-tilemap
- game-designer
- game-assets

---

## 3) Create and Enter a New RPG Project Folder

```bash
mkdir -p ~/projects/retro-rpg
cd ~/projects/retro-rpg
```

If you are on Windows PowerShell instead of WSL, use:

```powershell
New-Item -ItemType Directory -Force -Path .\retro-rpg
Set-Location .\retro-rpg
```

---

## 4) Launch Hermes Interactive Session

```bash
hermes
```

Now you are in Hermes chat mode. The rest of this guide is copy/paste prompts.

---

## 5) Paste This Full Master Prompt (One-Shot RPG Builder)

Paste the full block below exactly as-is:

```text
You are my senior game director + lead gameplay engineer.

Goal:
Build a polished, retro top-down action RPG in Phaser, optimized for browser play, with a clear production path from prototype to vertical slice.

Hard constraints:
- Use Phaser architecture with modular scenes and data-driven configs.
- Use tilemap pipeline suitable for Tiny Swords style content.
- Keep code maintainable, production-friendly, and easy to extend.
- Separate gameplay data from logic where possible (JSON/config modules).
- Include keyboard controls and gamepad support.
- Include save/load scaffolding.
- Keep all implementation deterministic and tunable.

You must use these skill roles while working:
- plan: define milestones and execution order.
- phaser-gamedev: implement game systems and scene code.
- tinyswords-tilemap: tilemap, layers, collisions, spawn markers, map workflow.
- game-designer: progression, combat feel, pacing, economy balancing.
- game-assets: asset manifest, naming convention, pipeline constraints.
- develop-web-game: integration, polish, performance, packaging.

Deliverables (in order):
1) Project plan with milestones and acceptance checks.
2) File/folder structure for Phaser RPG project.
3) Vertical slice implementation plan (town + field + mini dungeon).
4) Core systems:
   - Player movement/state machine
   - Melee attack + hitbox windows + i-frames
   - Enemy AI (idle/chase/attack/retreat)
   - Health/stamina/XP loop
   - Inventory/equipment basics
   - Quest state model
5) Tilemap/world pipeline:
   - Layer strategy
   - Collision strategy
   - Spawn/object markers
   - Scene transitions/portals
6) Data tables:
   - enemies, weapons, loot, progression curves
7) UX and polish:
   - camera behavior
   - hit pause, shake, feedback
   - pause menu + settings + rebinding hooks
8) Build/run commands and release checklist.

Work mode:
- Do not dump everything at once.
- Produce Milestone 1 first, then ask for "continue".
- Keep each milestone actionable and implementation-ready.
```

AFK option (recommended): add this line at the end of your master prompt before sending it:

```text
Do not wait for user input between milestones. Auto-advance through all milestones and stop only after Milestone 8 with the final line: RPG_PLAN_COMPLETE
```

That usually removes the need for any manual `continue` messages.

If your session still pauses for `continue`, use the opt-in AFK runner in this repo.

Important:
- This is explicitly opt-in.
- Regular Hermes projects are unchanged unless you run the AFK script/command.
- This repo can supervise Hermes runs and recover more safely, but it does not remove Hermes core sandbox/tool/provider restrictions.

### AFK Runner (PowerShell)

Save your master prompt as `rpg-master-prompt.txt`, then run:

```powershell
.\run-hermes-rpg-afk.ps1
```

Or via npm:

```powershell
npm run hermes:afk:rpg
npm run hermes:afk:caveman
```

### AFK Runner (WSL/Linux)

Save your master prompt as `rpg-master-prompt.txt`, then run:

```bash
bash ./run-hermes-rpg-afk.sh
```

Or via npm:

```bash
npm run hermes:afk:rpg
npm run hermes:afk:caveman
```

The runner behavior:
- Sends your prompt first
- Detects when Hermes asks for `continue`
- Sends `continue` automatically (up to a capped amount)
- Stops when it sees `RPG_PLAN_COMPLETE`
- Writes all output to `hermes-rpg-afk.log`

The caveman preset adds extra guardrails for brittle codegen runs:
- Prepends a conservative execution prompt
- Detects hard failure patterns such as empty model responses and repeated tool errors
- Sends one bounded recovery prompt instead of blindly continuing
- Stops cleanly if the run is still unstable

Use caveman mode when you are doing large game scaffolds, project recovery, or package/config edits late in a long run:

```powershell
.\run-hermes-rpg-afk.ps1 -Preset caveman
```

```bash
bash ./run-hermes-rpg-afk.sh rpg-master-prompt.txt 12 hermes-caveman-afk.log caveman
```

If you need this for non-RPG work, use the generic command:

```bash
npm run hermes:afk -- --prompt-file ./your-prompt.txt --auto-continue --max-continues 12 --done-marker YOUR_DONE_MARKER
```

If you want the runner to attempt a single conservative recovery pass immediately, use:

```bash
npm run hermes:afk:recover
```

---

## 6) Paste These Focus Prompts (Use After Master Prompt)

Use these one-by-one to force high-quality outputs.

### A) Architecture Lock Prompt

```text
Lock the architecture now.
Return:
1) final folder tree,
2) scene lifecycle contract,
3) state ownership rules,
4) event bus conventions,
5) where all tunable data lives.
Do not write placeholder fluff.
```

### B) Combat Feel Prompt

```text
Design combat feel for a retro action RPG:
- 3-hit combo timing windows
- stamina costs and regen
- dodge roll i-frames
- enemy telegraph timing
- hitstop and knockback values
Return exact tunable numbers and explain intended feel.
```

### C) Tilemap Pipeline Prompt

```text
Define my full tilemap pipeline for Phaser + Tiled:
- required layers and naming standards
- collision rules
- spawn markers for player/enemies/NPCs/chests/portals
- object property schema
- map validation checklist before export
Return this as a strict, implementation-ready spec.
```

### D) Progression and Economy Prompt

```text
Design progression for the first 90 minutes:
- XP curve
- weapon unlock pace
- loot rarity and drop rates
- consumable economy
- difficulty ramp per zone
Return numbers in compact tables with balancing rationale.
```

### E) Vertical Slice Acceptance Prompt

```text
Create a hard acceptance checklist for vertical slice release.
Must include:
- gameplay correctness checks
- performance budget checks
- UI/UX checks
- save/load checks
- regression checks
Return pass/fail criteria only (no vague language).
```

---

## 7) If You Want Hermes to Generate Code Next

After planning is locked, use this exact prompt:

```text
Generate Milestone 1 implementation now.
Requirements:
- Provide files in write order.
- For each file: full content, no omissions.
- Include run instructions after code.
- Keep strict compatibility with previous architecture decisions.
- If a file is unchanged, do not regenerate it.
```

Then repeat for later milestones:

```text
Generate Milestone 2 implementation now with the same rules.
```

---

## 8) Recommended Build Rhythm (Important)

Use this rhythm every milestone:
1. Ask Hermes for plan/spec.
2. Ask Hermes for code for only that milestone.
3. Run the game and test immediately.
4. Fix defects before moving on.
5. Commit milestone.

Suggested commit pattern:

```bash
git init
git add .
git commit -m "milestone-1 architecture and core loop"
```

---

## 9) Quick Troubleshooting

If Hermes output becomes generic, paste:

```text
Your output got generic. Re-issue the last answer with concrete implementation detail, exact values, explicit file contracts, and no high-level filler.
```

If Hermes ignores your constraints, paste:

```text
Re-align with my hard constraints exactly. List each constraint and show how your previous answer satisfies it. Then provide corrected output only.
```

If skill behavior is unclear, run outside Hermes chat:

```bash
hermes skills list
```

---

## 10) Fast Start Version (If You Want to Move Immediately)

From terminal:

```bash
mkdir -p ~/projects/retro-rpg && cd ~/projects/retro-rpg && hermes
```

Then paste only this:

```text
Build me a polished retro top-down action RPG in Phaser using plan + phaser-gamedev + tinyswords-tilemap + game-designer + game-assets + develop-web-game. Start with milestone plan and acceptance criteria, then wait for continue.
```

---

## 11) What "Done" Looks Like

You are done when you have:
- A playable vertical slice
- Stable combat loop
- Working tilemap transitions
- Save/load functioning
- Performance acceptable on your target browser
- A checklist-driven path to full game expansion

That is your complete RPG-from-Hermes dummies workflow.
