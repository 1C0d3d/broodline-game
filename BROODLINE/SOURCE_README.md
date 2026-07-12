# BROODLINE

An original, single-player browser FPS built around escalating spider-survival rounds. The game is genre-inspired, but all branding, map design, interface, enemies, weapons, audio, and visual assets are original or permissively licensed.

## Play

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173` (or the URL printed by Vite), choose **Begin Hunt**, and click the game view to lock the pointer.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Mouse | Aim |
| Left mouse | Fire |
| Right mouse | Quick reload |
| `Shift` | Sprint |
| `R` | Reload |
| `E` | Buy, repair, restore power, or unlock |
| `1 / 2 / 3` or mouse wheel | Switch owned weapons |
| `Esc` or `P` | Pause |
| `M` | Toggle sound |

Basic gamepad movement, aiming, firing, reloading, interaction, sprinting, weapon cycling, and pause are also supported.

## Survival systems

- Escalating rounds with bounded active enemies and every-fifth-round Broodmother encounters
- Crawler, skitter, venom widow, and armored boss behavior
- Pistol, carbine, and scattergun with ammo, reloads, wall buys, and weapon calibration
- Scrap economy, score, health, resin armor, pickups, overcharge, and high-score persistence
- Rebuildable breaches, auxiliary power, a purchasable lab route, and upgrade terminal
- Title, briefing, HUD, round banners, captions, settings, pause, restart, and results states
- Keyboard/mouse and basic gamepad support

## Build

```powershell
npm run typecheck
npm run build
npm run preview
```

Third-party asset provenance and license terms are recorded in [ASSET_LICENSES.md](./ASSET_LICENSES.md).
