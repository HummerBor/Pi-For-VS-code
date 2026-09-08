# <img src="media/pi-icon.png" width="36" align="top" alt="Pi For VSC"> Pi For VSC

[English](./README_EN.md) | [简体中文](./README.md)

A VS Code sidebar extension that provides a graphical interface for [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). The interaction takes cues from Claude Code — essentially a shell around pi: chat, send files, and watch it work, all inside your editor.

> The panel UI defaults to Simplified Chinese. Click the **中 / EN** button in the panel header to switch to English.

## Themes

The panel ships with a few hand-tuned color schemes, switchable via the ☀ / ☾ icon in the header — no settings files required:

![Themes](media/themes.png)

- **Midnight Blue** (default) / **Dark** / **Light**: three fixed, hand-tuned palettes, with layering and contrast adjusted for long working sessions
- **Follow VS Code**: no locked palette — colors adapt to the current window's light/dark theme. Paired with wallpaper extensions like BackgroundCover, the panel blends into your wallpaper instead of standing out as a foreign block

![Follow VS Code theme (wallpaper extension scenario)](media/跟随vsc.png)

## Highlights

- **Zero terminal**: install pi, configure API keys, switch models, manage sessions — all with clicks in the panel
- **Full visibility**: tool calls, thinking process, queued steering messages, interrupt & resume — all in the panel
- **Lightweight**: a lightweight webview plus one pi process. No Electron nesting; it stays snappy even when left running all day
- **Customizable**: the UI is just strings to edit — activity bar icon, welcome-page duck and tips, color themes. Edit, reload, done (see [FEATURES.md](./FEATURES.md))
- **Local-first data**: session history and API credentials stay on your machine. No cloud, no telemetry

As for models, pi supports multiple providers (GLM / DeepSeek / Kimi / Qwen / OpenRouter / Gemini…), switchable from the bottom bar.

## How it works

Simple: the extension and pi each mind their own half.

> **VS Code sidebar** (this extension): draws the UI, collects input
>
> **⇅ The two talk over JSONL request/response** — every step you see on screen is pi genuinely doing the work
>
> **pi background process** (`--mode rpc`): does everything — model calls, tool execution, sessions, retries, compaction

- **pi is the star**: model calls, tool execution and session management are all done by pi; the extension does nothing agent-related. That's why this extension needs pi installed first (if it's missing, the extension offers a one-click install).
- **The extension only does two things**: render pi's events into a UI, and send your input to pi.
- **So it's light**: the whole UI is a local HTML/CSS/JS page — no frameworks, no bundling magic. The daily overhead is tiny and won't slow down your editor.

## Getting started

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=HummerBor.pi-for-vscode) — search for `Pi For VSC`, or open the link and click Install to launch VS Code → click the pi icon in the activity bar.

First-timers, don't worry: if pi isn't installed you'll be guided through a one-click install; if no API key is configured you'll be walked through it in the panel. Then just chat.

Once set up, here's what working looks like — chatting and running tools in the left panel while you keep writing code on the right:

![Working](media/测试.png)

You can also manually install a `.vsix` from [Releases](https://github.com/HummerBor/Pi-For-VS-code/releases) (Extensions view → "Install from VSIX"), or clone the repo and build it yourself with `npm install && npx vsce package`.

## Built with itself

Every version of this extension was built inside its own panel: <img src="media/pi-icon.png" width="18" align="top"> open the project → tell pi "change the duck's pose on the welcome page" → it edits the source, compiles, and packages a new `.vsix` → install and reload — **it updates itself**.

All iterations from 0.0.x to today, including the README you're reading, were written this way. So "the UI is yours to change" isn't a slogan: even the author works this way, and for you it's only easier.

## Docs

- [FEATURES.md](./FEATURES.md) — full feature list, customization reference, architecture notes (Chinese)
- [HANDOVER.md](./HANDOVER.md) — developer handover: module details, pitfalls, porting guide (Chinese)

## Roadmap

- Multi-tab parallel sessions inside the panel
- Official Marketplace listing
- Attachments & cross-project session enhancements

Requests or bug reports are welcome at [Issues](../../issues).

Happy hacking, and remember to drink water <img src="media/pi-icon.png" width="20" align="top">

## License

[MIT](./LICENSE)
