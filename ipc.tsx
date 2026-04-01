/**
 * NoNitroClips — Optional Electron IPC Bridge (ipc.tsx)
 *
 * This file is NOT required for the plugin to work.
 * It enables silent auto-save to a custom folder and auto-open in the
 * system default media player — no "Save As" dialog.
 *
 * ─── HOW TO USE ────────────────────────────────────────────────────────────
 * This is a main-process snippet. If you maintain a custom Vencord build,
 * import and call registerClipIpc() from your patcher/main-process entry:
 *
 *   import { registerClipIpc } from "./userplugins/NoNitroClips/ipc";
 *   registerClipIpc(ipcMain);
 *
 * Regular users can ignore this file — the plugin auto-falls-back to a
 * browser-style download prompt.
 *
 * ─── DEPENDENCIES ──────────────────────────────────────────────────────────
 * Node.js built-ins only (path, fs, os). No extra packages required.
 */

import path from "path";
import fs from "fs";
import { homedir } from "os";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SavePayload {
    filename: string;
    savePath: string | null;
    data: ArrayBuffer;
}

interface SaveResult {
    ok: boolean;
    path?: string;
    error?: string;
}

// ─── Main-process IPC Handlers ────────────────────────────────────────────────

/**
 * Registers two IPC handles on the Electron main process:
 *
 *   DISCORD_CLIP_SAVE  — write raw bytes to disk (Downloads or custom path)
 *   DISCORD_CLIP_OPEN  — open the saved file with the default OS application
 */
export function registerClipIpc(ipcMain: Electron.IpcMain): void {
    /**
     * DISCORD_CLIP_SAVE
     * Receives a filename, optional save path, and raw ArrayBuffer from the
     * renderer, then writes it to disk.  blob: URLs don't cross the process
     * boundary, so the renderer converts the blob to an ArrayBuffer first.
     */
    ipcMain.handle("DISCORD_CLIP_SAVE", async (_event: Electron.IpcMainInvokeEvent, payload: SavePayload): Promise<SaveResult> => {
        try {
            const dir = payload.savePath
                ? path.resolve(payload.savePath)
                : path.join(homedir(), "Downloads");

            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const dest = path.join(dir, payload.filename);
            fs.writeFileSync(dest, Buffer.from(payload.data));

            return { ok: true, path: dest };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, error: message };
        }
    });

    /**
     * DISCORD_CLIP_OPEN
     * Opens the saved file using the default system application
     * (e.g. Windows Media Player, VLC, QuickTime).
     */
    ipcMain.handle("DISCORD_CLIP_OPEN", async (_event: Electron.IpcMainInvokeEvent, filename: string): Promise<void> => {
        try {
            const { shell } = await import("electron");
            const dest = path.join(homedir(), "Downloads", filename);
            if (fs.existsSync(dest)) await shell.openPath(dest);
        } catch (err) {
            console.error("[NoNitroClips/ipc] Could not open clip:", err);
        }
    });
}

// ─── Renderer-side helper ────────────────────────────────────────────────────

/**
 * Call this from the renderer (index.tsx) instead of fallbackDownload() when
 * ipcRenderer is available and the main-process handlers are registered.
 *
 * Transfers raw ArrayBuffer bytes over IPC — blob: URLs cannot cross the
 * process boundary in Electron.
 *
 * @param blob        The recorded media blob
 * @param filename    Target filename (e.g. "discord-clip_2024-06-01_12-00-00.webm")
 * @param savePath    Absolute folder path, or null to use Downloads
 * @param autoOpen    Whether to open the file in the default player after save
 * @returns           true on success, false on any error (caller should fallback)
 */
export async function saveViaNativeIpc(
    blob: Blob,
    filename: string,
    savePath: string | null,
    autoOpen: boolean,
): Promise<boolean> {
    try {
        const { ipcRenderer } = (window as any).require("electron") as {
            ipcRenderer: Electron.IpcRenderer;
        };

        const data = await blob.arrayBuffer();

        const result: SaveResult = await ipcRenderer.invoke("DISCORD_CLIP_SAVE", {
            filename,
            savePath,
            data,
        } satisfies SavePayload);

        if (!result.ok) {
            console.error("[NoNitroClips/ipc] Main-process save failed:", result.error);
            return false;
        }

        if (autoOpen) {
            await ipcRenderer.invoke("DISCORD_CLIP_OPEN", filename).catch((err: unknown) => {
                console.warn("[NoNitroClips/ipc] Auto-open failed:", err);
            });
        }

        return true;
    } catch (err) {
        console.error("[NoNitroClips/ipc] IPC call failed:", err);
        return false;
    }
}

// ─── Status UI Component ─────────────────────────────────────────────────────

/**
 * Tiny React badge rendered inside the settings panel that shows whether
 * the native IPC bridge is detected and functional.
 *
 * Usage (in index.tsx settingsAboutComponent):
 *   <IpcStatusBadge />
 */
import { React } from "@webpack/common";

export function IpcStatusBadge(): React.ReactElement {
    const hasIpc = typeof (window as any).require === "function" &&
        Boolean((window as any).require?.("electron")?.ipcRenderer);

    return (
        <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px",
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 600,
            background: "var(--background-tertiary)",
            color: hasIpc ? "#23a55a" : "#f0b232",
            userSelect: "none",
        }}>
            {hasIpc
                ? "⚡ Native IPC: active (silent save enabled)"
                : "⚠ Native IPC: not available (browser download fallback)"}
        </div>
    );
}
