# NoNitroClips — Vencord User Plugin

> **Record rolling audio/video clips from any Discord voice channel — no Nitro required.**

---

## ✂️ Features

| Feature | Details |
|---|---|
| **Rolling buffer** | Keeps the last 30 / 60 / 120 seconds of audio+video in memory |
| **One-key clip save** | Default **Alt + C** (fully customisable) |
| **Formats** | WebM (native, no deps) or MP4 (requires ffmpeg in PATH) |
| **Filename** | `discord-clip_YYYY-MM-DD_HH-MM-SS.webm` |
| **Voice + streaming** | Works in plain voice calls *and* while screen-sharing / streaming |
| **Context menu** | Right-click a voice channel → *✂️ Save Clip* |
| **Notifications** | Toast when a clip is saved (toggle-able) |
| **Settings panel** | Full GUI in Vencord settings |
| **Auto-open** | Optionally opens the clip in your default media player |
| **Audio-only mode** | When not streaming, record mic only (saves space) |
| **Nitro patch** | Removes any `isPremium` / `isEligibleForClips` gates Discord may add |

---

## 📁 Installation

1. Locate your Vencord `src/userplugins/` directory.
   - Usually `<repo>/src/userplugins/`
2. Create the folder `NoNitroClips/` inside it.
3. Copy **`index.tsx`** (and optionally `ipc.tsx`) into that folder.
4. Rebuild Vencord:
   ```bash
   pnpm build          # or: node scripts/build.mjs
   ```
5. Open Discord → **Settings → Vencord → Plugins** → enable **NoNitroClips**.

> **No `package.json` needed** — Vencord's build system handles TypeScript compilation automatically.

---

## ⚙️ Settings

Open **Discord Settings → Vencord → Plugins → NoNitroClips → ⚙️**

| Setting | Default | Description |
|---|---|---|
| Enabled | ✅ | Master on/off switch |
| Clip Length | 30 s | Rolling buffer duration |
| Hotkey | `Alt+C` | Key combo to save clip |
| Save Location | *(Downloads)* | Absolute path, or blank for Downloads |
| Auto-open clip | ❌ | Open in default player after save |
| Audio only | ❌ | Skip video when not streaming |
| Output format | WebM | WebM (recommended) or MP4 |
| Show toasts | ✅ | Desktop notification on save |

---

## 🎹 Hotkey Format

Use `+`-separated modifier names.  Examples:

```
Alt+C          ← default
Ctrl+Shift+S
Meta+Shift+R   ← Cmd+Shift+R on macOS
```

Recognised modifiers: `Alt`, `Ctrl` / `Control`, `Shift`, `Meta` / `Cmd` / `Super`

---

## 🔊 How It Records

The plugin uses a **three-tier stream acquisition strategy**:

```
1. Active Discord screen-share / game stream  (video + audio, best quality)
       ↓ (if unavailable)
2. navigator.mediaDevices.getDisplayMedia()   (screen + system audio, Chrome/Electron)
       ↓ (if unavailable / audio-only mode)
3. navigator.mediaDevices.getUserMedia()      (microphone only, always works)
```

All audio/video chunks are pushed into a **time-based ring buffer**.  
On hotkey press the buffer is flushed to a `Blob`, then saved via:
- **Electron IPC** (desktop Discord / Vencord) — direct filesystem write
- **`<a download>` fallback** — standard browser download prompt

---

## 🖥️ Native Save (Optional IPC Bridge)

By default the plugin uses a browser-style download which opens a *Save As* dialog.

For **silent auto-save** to a specific folder, register the IPC handlers from `ipc.tsx` in your Vencord main-process entry point:

```ts
// In your custom Vencord patcher / preload main process file:
import { registerClipIpc } from "./userplugins/NoNitroClips/ipc";
registerClipIpc(ipcMain);
```

This enables the **Save Location** setting to work silently without a dialog.

---

## 🩹 Patches Applied

```
CLIPS_NITRO_UPSELL  →  isPremium check bypassed
"clips"             →  isEligibleForClips() always returns true
```

Both patches are marked `noWarn: true` — they are no-ops if Discord hasn't shipped the target code yet.

---

## ⚠️ Limitations & Known Issues

| Limitation | Notes |
|---|---|
| **System audio on Linux** | `getDisplayMedia` system audio capture requires PipeWire + a compatible browser/Electron. Falls back to mic-only. |
| **MP4 output** | `MediaRecorder` doesn't natively produce H.264 MP4 in Electron. The plugin names the file `.mp4` but the container is still WebM. Run `ffmpeg -i clip.webm clip.mp4` for true MP4. |
| **Loopback audio** | Discord's output (other people's voices) requires system audio capture. If `getDisplayMedia` isn't available, only your microphone is recorded. |
| **Buffer on startup** | There's a 0–2 second gap after joining a channel before the first chunks arrive. |
| **Video quality** | Capped at 4 Mbps by default. Raise `videoBitsPerSecond` in `index.tsx` for higher quality (uses more RAM). |

---

## 🛠️ Customisation Tips

**Increase video bitrate** (line ~100 of `index.tsx`):
```ts
videoBitsPerSecond: 8_000_000,   // 8 Mbps
```

**Add more clip-length options**:
```ts
{ label: "5 minutes", value: 300 },
```

**Custom notification sound** — hook into `showNotification`'s `onClick` to play an `AudioContext` beep.

---

## 📄 License

GPL-3.0-or-later — same as Vencord itself.
