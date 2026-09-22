# <img src="https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/pi-icon.png" width="36" align="top" alt="Pi For VSC"> Pi For VSC

[English](./README_EN.md) | [简体中文](./README.md)

A visual VS Code extension for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that embeds the pi engine in-process — streaming as fast as the terminal. Claude Code-style interaction; lightweight, and the UI is yours to tweak — it's just a few local files; edit and reload.

- **Starts in a second**: in-process pi, no subprocess spawn, no CLI cold start — the panel is ready the moment you open it
- **History loads instantly**: session list served from a fingerprint cache, past sessions pop up in milliseconds

## Themes

![Themes](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/themes.png)

- **Follows VS Code**: adapts to the window's color scheme; blends into wallpaper extensions too

![Follow VS Code theme](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/%E8%B7%9F%E9%9A%8Fvsc.png)

## Getting started

Search `Pi For VSC` in the [Marketplace](https://marketplace.visualstudio.com/items?itemName=HummerBor.pi-for-vscode) → click the pi icon in the activity bar. Missing pi triggers a one-click install; missing keys walk you through setup. Then just chat:

![Working](https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/%E6%B5%8B%E8%AF%95.png)

## Built with itself

Every version of this extension was built inside its own panel: open the project → tell pi "change the duck's pose on the welcome page" → it edits the source, compiles, packages a new `.vsix` → install and reload — **it updates itself**, including the README you're reading.

Requests or bugs welcome at [Issues](https://github.com/HummerBor/Pi-For-VS-code/issues). Happy hacking, and remember to drink water <img src="https://raw.githubusercontent.com/HummerBor/Pi-For-VS-code/main/media/pi-icon.png" width="20" align="top">

## License

[MIT](https://github.com/HummerBor/Pi-For-VS-code/blob/main/LICENSE)
