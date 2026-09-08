# <img src="media/pi-icon.png" width="36" align="top" alt="Pi For VSC"> Pi For VSC

[English](./README_EN.md) | [简体中文](./README.md)

A visual VS Code extension for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), built on pi's RPC mode. Claude Code-style interaction; lightweight, and the UI is yours to tweak — it's just a few local files; edit and reload.

## Themes

![Themes](media/themes.png)

- **Follow VS Code**: adapts to the window's color scheme; blends into wallpaper extensions too

![Follow VS Code theme](media/跟随vsc.png)

## Highlights

- **No terminal needed**: pi is installed with one click from the panel and launched in the background — you just describe the task; keys, models and sessions are clicks too
- **Lightweight**: a webview plus one pi process, no Electron nesting — happy to stay open all day
- **Customizable**: icon, tips, themes — all just strings to edit; reload and done (see [FEATURES.md](./FEATURES.md))
- **Local-first data**: session history and credentials stay on your machine, no cloud, no telemetry

## Getting started

Search `Pi For VSC` in the [Marketplace](https://marketplace.visualstudio.com/items?itemName=HummerBor.pi-for-vscode) → click the pi icon in the activity bar. Missing pi triggers a one-click install; missing keys walk you through setup. Then just chat:

![Working](media/测试.png)

## Built with itself

Every version of this extension was built inside its own panel: open the project → tell pi "change the duck's pose on the welcome page" → it edits the source, compiles, packages a new `.vsix` → install and reload — **it updates itself**, including the README you're reading.

## Docs

- [FEATURES.md](./FEATURES.md) — feature list, customization reference, architecture (Chinese)

## Roadmap

- Multi-tab parallel sessions in the panel
- Attachments & cross-project session enhancements

Requests or bugs welcome at [Issues](../../issues). Happy hacking, and remember to drink water <img src="media/pi-icon.png" width="20" align="top">

## License

[MIT](./LICENSE)
