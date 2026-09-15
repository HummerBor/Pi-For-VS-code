# <img src="media/pi-icon.png" width="36" align="top" alt="Pi For VSC"> Pi For VSC

[English](./README_EN.md) | [简体中文](./README.md)

A visual VS Code extension for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that embeds the pi engine in-process — streaming as fast as the terminal. Claude Code-style interaction; lightweight, and the UI is yours to tweak — it's just a few local files; edit and reload.

## Themes

![Themes](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/themes.png)

- **Follow VS Code**: adapts to the window's color scheme; blends into wallpaper extensions too

![Follow VS Code theme](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/%E8%B7%9F%E9%9A%8Fvsc.png)

## Highlights

- **In-process, not a remote-controlled CLI**: the pi engine is imported as an SDK into the extension (nearly every agent extension spawns a subprocess and parses strings) — permission modes, queued steering and session management come straight from pi's native semantics; the terminal TUI and this panel behave identically, and streaming speed is just a side effect
- **True parallel sessions**: multiple tabs, each an independent conversation running at once; tab switches restore state from an atomic snapshot, and scrolling up mid-stream never gets yanked back
- **Queue you can take back**: messages sent while pi is working queue up automatically — take any back to the editor with one click (pi's native dequeue semantics, not invented delete)
- **Change review**: when pi finishes a run, the panel lists exactly the files it touched this run — open a native diff in one click, or revert a file whole if you don't like it (your own uncommitted work is never touched). The confidence to run in Auto mode

Session history and credentials stay on your machine — no cloud, no telemetry.

## Getting started

Search `Pi For VSC` in the [Marketplace](https://marketplace.visualstudio.com/items?itemName=HummerBor.pi-for-vscode) → click the pi icon in the activity bar. Missing pi triggers a one-click install; missing keys walk you through setup. Then just chat:

![Working](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/%E6%B5%8B%E8%AF%95.png)

## Why build it

Every existing option has its own kind of heaviness: **Codex** makes my machine lag; **Claude Code** burns tokens, and switching models requires proxies like cc-switch; I tried **Hermes, DSH, OpenClaw** too — all huge, all clunky to drive. pi is different — light, transparent, no black boxes, perfect for exploring token-saving and memory-saving workflows. This extension is the product of that exploration: themes are yours to play with, the source is right here, and everyone is welcome to join in.

## Built with itself

Every version of this extension was built inside its own panel: open the project → tell pi "change the duck's pose on the welcome page" → it edits the source, compiles, packages a new `.vsix` → install and reload — **it updates itself**, including the README you're reading.

Requests or bugs welcome at [Issues](../../issues). Happy hacking, and remember to drink water <img src="media/pi-icon.png" width="20" align="top">

## License

[MIT](./LICENSE)
