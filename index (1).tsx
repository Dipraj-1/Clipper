/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * NoNitroClips — Save rolling audio/video clips from voice channels without Nitro.
 *
 * Place this folder at:
 *   <Vencord src>/userplugins/NoNitroClips/index.tsx
 *
 * Vencord will auto-detect it as a user plugin.
 */

import { definePluginSettings } from "@api/Settings";
import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import definePlugin, { OptionType } from "@utils/types";
import { waitFor } from "@webpack";
import { FluxDispatcher, Menu, SelectedChannelStore, UserStore } from "@webpack/common";

// ─── Types ────────────────────────────────────────────────────────────────────

interface VoiceStateEntry {
    userId?: string;
    user?: { id: string };
    channelId?: string | null;
    newChannelId?: string | null;
}

interface VoiceStatePayload {
    voiceStates?: VoiceStateEntry[];
    userId?: string;
    channelId?: string | null;
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Enable clip recording in voice channels",
        default: true,
        restartNeeded: false,
    },
    clipLength: {
        type: OptionType.SELECT,
        description: "Rolling buffer length (seconds)",
        options: [
            { label: "30 seconds", value: 30, default: true },
            { label: "60 seconds", value: 60 },
            { label: "120 seconds", value: 120 },
        ],
    },
    hotkey: {
        type: OptionType.STRING,
        description: 'Hotkey to save a clip (e.g. "Alt+C")',
        default: "Alt+C",
        restartNeeded: false,
    },
    saveLocation: {
        type: OptionType.STRING,
        description: "Save folder path (leave blank for Downloads)",
        default: "",
        restartNeeded: false,
    },
    autoOpenClip: {
        type: OptionType.BOOLEAN,
        description: "Automatically open the clip after saving",
        default: false,
        restartNeeded: false,
    },
    audioOnly: {
        type: OptionType.BOOLEAN,
        description: "Record audio only when not streaming (no webcam/screen)",
        default: false,
        restartNeeded: false,
    },
    outputFormat: {
        type: OptionType.SELECT,
        description: "Output file format",
        options: [
            { label: "WebM (recommended)", value: "webm", default: true },
            { label: "MP4 (requires ffmpeg in PATH)", value: "mp4" },
        ],
    },
    showToasts: {
        type: OptionType.BOOLEAN,
        description: "Show notification when a clip is saved",
        default: true,
        restartNeeded: false,
    },
});

// ─── Ring Buffer ──────────────────────────────────────────────────────────────

/**
 * A time-based ring buffer. We keep all recorded chunks with timestamps,
 * then on save we only return chunks newer than `maxDurationMs`.
 */
class TimedRingBuffer {
    private entries: Array<{ chunk: Blob; ts: number }> = [];
    private maxDurationMs: number;

    constructor(maxDurationMs: number) {
        this.maxDurationMs = maxDurationMs;
    }

    setMaxDuration(ms: number): void {
        this.maxDurationMs = ms;
        this.prune();
    }

    push(chunk: Blob): void {
        this.entries.push({ chunk, ts: Date.now() });
        this.prune();
    }

    private prune(): void {
        const cutoff = Date.now() - this.maxDurationMs;
        this.entries = this.entries.filter(e => e.ts >= cutoff);
    }

    getChunks(): Blob[] {
        this.prune();
        return this.entries.map(e => e.chunk);
    }

    clear(): void {
        this.entries = [];
    }

    get isEmpty(): boolean {
        return this.entries.length === 0;
    }
}

// ─── Core State ───────────────────────────────────────────────────────────────

let ringBuffer: TimedRingBuffer | null = null;
let mediaRecorder: MediaRecorder | null = null;
let capturedStream: MediaStream | null = null;
let currentChannelId: string | null = null;
let hotkeyListener: ((e: KeyboardEvent) => void) | null = null;
let isSaving = false;

// ─── Webpack Module Lookups ────────────────────────────────────────────────────

let StreamStore: any = null;
waitFor(["getAllActiveStreams", "getStreamForUser"], (m: any) => { StreamStore = m; });

// ─── Stream Acquisition ───────────────────────────────────────────────────────

/**
 * Tries to obtain a combined MediaStream from the current voice/stream session.
 *
 * Priority:
 *   1. Active screen-share / game capture stream  (video + audio, best quality)
 *   2. getDisplayMedia with system audio           (Electron / Chrome loopback)
 *   3. getUserMedia microphone fallback            (always works)
 */
async function acquireStream(): Promise<MediaStream | null> {
    const tracks: MediaStreamTrack[] = [];

    // ── 1. Discord's own active stream ────────────────────────────────────
    try {
        if (StreamStore) {
            const streams: any[] = StreamStore.getAllActiveStreams?.() ?? [];
            const myUserId = UserStore?.getCurrentUser?.()?.id;
            const myStream = streams.find(
                (s: any) => s.ownerId === myUserId || s.userId === myUserId
            );
            if (myStream?.stream instanceof MediaStream) {
                myStream.stream
                    .getTracks()
                    .forEach((t: MediaStreamTrack) => tracks.push(t.clone()));
            }
        }
    } catch (err) {
        console.warn("[NoNitroClips] Could not access Discord stream:", err);
    }

    // ── 2. getDisplayMedia (screen + system audio) ────────────────────────
    if (tracks.length === 0 && !settings.store.audioOnly) {
        try {
            const displayStream = await (navigator.mediaDevices as any).getDisplayMedia({
                video: { frameRate: 30, width: 1920, height: 1080 },
                audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 48_000 },
                preferCurrentTab: true,
                selfBrowserSurface: "include",
                systemAudio: "include",
            });
            displayStream.getTracks().forEach((t: MediaStreamTrack) => tracks.push(t));
        } catch (err) {
            console.info("[NoNitroClips] getDisplayMedia unavailable, falling back to mic:", err);
        }
    }

    // ── 3. Microphone fallback ────────────────────────────────────────────
    try {
        const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48_000,
                channelCount: 2,
            },
            video: false,
        });
        micStream.getAudioTracks().forEach(t => tracks.push(t));
    } catch (err) {
        console.warn("[NoNitroClips] Could not get microphone stream:", err);
    }

    return tracks.length > 0 ? new MediaStream(tracks) : null;
}

// ─── MIME Type Selection ──────────────────────────────────────────────────────

function getBestMimeType(): string {
    const candidates =
        settings.store.outputFormat === "mp4"
            ? ["video/mp4;codecs=h264,aac", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
            : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "audio/webm;codecs=opus", "video/webm"];

    return candidates.find(t => MediaRecorder.isTypeSupported(t)) ?? "";
}

// ─── Recording Lifecycle ──────────────────────────────────────────────────────

async function startRecording(channelId: string): Promise<void> {
    if (mediaRecorder?.state === "recording") return;

    const maxMs = (settings.store.clipLength as number) * 1_000;
    ringBuffer = new TimedRingBuffer(maxMs);

    capturedStream = await acquireStream();
    if (!capturedStream) {
        console.warn("[NoNitroClips] No stream available to record.");
        return;
    }

    const mimeType = getBestMimeType();
    const recorderOptions: MediaRecorderOptions = {
        mimeType: mimeType || undefined,
        audioBitsPerSecond: 192_000,
        videoBitsPerSecond: 4_000_000,
    };

    try {
        mediaRecorder = new MediaRecorder(capturedStream, recorderOptions);
    } catch {
        console.warn("[NoNitroClips] Retrying MediaRecorder without options.");
        mediaRecorder = new MediaRecorder(capturedStream);
    }

    mediaRecorder.ondataavailable = (evt: BlobEvent) => {
        if (evt.data?.size > 0) ringBuffer?.push(evt.data);
    };

    mediaRecorder.onerror = (evt: Event) => {
        console.error("[NoNitroClips] MediaRecorder error:", evt);
    };

    // 500 ms timeslice → fine-grained ring buffer pruning
    mediaRecorder.start(500);
    currentChannelId = channelId;
    console.info(`[NoNitroClips] Recording started — channel ${channelId} (${settings.store.clipLength}s buffer)`);
}

function stopRecording(): void {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
    mediaRecorder = null;

    capturedStream?.getTracks().forEach(t => t.stop());
    capturedStream = null;

    ringBuffer?.clear();
    ringBuffer = null;
    currentChannelId = null;

    console.info("[NoNitroClips] Recording stopped.");
}

// ─── Save Clip ────────────────────────────────────────────────────────────────

function buildFilename(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = [
        d.getFullYear(),
        pad(d.getMonth() + 1),
        pad(d.getDate()),
        "_",
        pad(d.getHours()),
        "-",
        pad(d.getMinutes()),
        "-",
        pad(d.getSeconds()),
    ].join("");
    const ext = settings.store.outputFormat === "mp4" ? "mp4" : "webm";
    return `discord-clip_${stamp}.${ext}`;
}

async function saveClip(): Promise<void> {
    if (isSaving) return;

    if (!ringBuffer || ringBuffer.isEmpty) {
        notify("⚠️ No clip data yet — stay in voice a moment and try again.", true);
        return;
    }

    isSaving = true;
    try {
        // Flush the current in-progress chunk
        if (mediaRecorder?.state === "recording") {
            await new Promise<void>(resolve => {
                const flush = () => {
                    mediaRecorder!.removeEventListener("dataavailable", flush);
                    resolve();
                };
                mediaRecorder!.addEventListener("dataavailable", flush);
                mediaRecorder!.requestData();
            });
        }

        const chunks = ringBuffer.getChunks();
        if (chunks.length === 0) {
            notify("⚠️ Buffer is empty — wait a moment and try again.", true);
            return;
        }

        const mimeType = getBestMimeType() || "video/webm";
        const blob = new Blob(chunks, { type: mimeType });
        const filename = buildFilename();
        const objectUrl = URL.createObjectURL(blob);

        // Prefer Electron IPC for silent filesystem saves
        const electronRequire = (window as any).require;
        const ipc = electronRequire?.("electron")?.ipcRenderer ?? null;

        if (ipc) {
            // Convert blob to ArrayBuffer for IPC transfer (blob URLs don't cross processes)
            const arrayBuffer = await blob.arrayBuffer();
            const result = await ipc
                .invoke("DISCORD_CLIP_SAVE", {
                    filename,
                    savePath: settings.store.saveLocation || null,
                    data: arrayBuffer,
                })
                .catch(() => ({ ok: false }));

            if (!result?.ok) fallbackDownload(objectUrl, filename);

            if (settings.store.autoOpenClip) {
                await ipc.invoke("DISCORD_CLIP_OPEN", filename).catch(() => {});
            }
        } else {
            fallbackDownload(objectUrl, filename);
        }

        if (settings.store.showToasts) {
            const dest = settings.store.saveLocation || "Downloads";
            notify(`✂️ Clip saved → ${dest}/${filename}`);
        }
    } catch (err) {
        console.error("[NoNitroClips] Save failed:", err);
        notify("❌ Failed to save clip. Check the DevTools console.", true);
    } finally {
        isSaving = false;
    }
}

function fallbackDownload(url: string, filename: string): void {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─── Notifications ────────────────────────────────────────────────────────────

function notify(body: string, isError = false): void {
    try {
        showNotification({
            title: "NoNitroClips",
            body,
            color: isError ? "#ed4245" : "#23a55a",
            onClick: () => {},
        });
    } catch {
        (isError ? console.error : console.info)(`[NoNitroClips] ${body}`);
    }
}

// ─── Hotkey ───────────────────────────────────────────────────────────────────

interface ParsedCombo {
    key: string;
    alt: boolean;
    ctrl: boolean;
    shift: boolean;
    meta: boolean;
}

function parseHotkey(raw: string): ParsedCombo {
    const parts = raw.toLowerCase().split("+").map(s => s.trim());
    const modifiers = new Set(["alt", "ctrl", "control", "shift", "meta", "cmd", "super"]);
    return {
        alt: parts.includes("alt"),
        ctrl: parts.includes("ctrl") || parts.includes("control"),
        shift: parts.includes("shift"),
        meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("super"),
        key: parts.find(p => !modifiers.has(p)) ?? "c",
    };
}

function registerHotkey(): void {
    unregisterHotkey();
    const combo = parseHotkey(settings.store.hotkey || "Alt+C");

    hotkeyListener = (evt: KeyboardEvent) => {
        if (!settings.store.enabled) return;
        if (evt.altKey !== combo.alt) return;
        if (evt.ctrlKey !== combo.ctrl) return;
        if (evt.shiftKey !== combo.shift) return;
        if (evt.metaKey !== combo.meta) return;
        if (evt.key.toLowerCase() !== combo.key) return;

        evt.preventDefault();
        evt.stopPropagation();
        void saveClip();
    };

    document.addEventListener("keydown", hotkeyListener, { capture: true });
}

function unregisterHotkey(): void {
    if (hotkeyListener) {
        document.removeEventListener("keydown", hotkeyListener, { capture: true });
        hotkeyListener = null;
    }
}

// ─── Voice State Handler ──────────────────────────────────────────────────────

function handleVoiceStateUpdate(entry: VoiceStateEntry): void {
    if (!settings.store.enabled) return;

    const myId = UserStore?.getCurrentUser?.()?.id;
    if (entry.userId !== myId && entry.user?.id !== myId) return;

    const nextChannelId: string | null = entry.channelId ?? entry.newChannelId ?? null;

    if (nextChannelId && nextChannelId !== currentChannelId) {
        if (currentChannelId) stopRecording();
        void startRecording(nextChannelId);
    } else if (!nextChannelId && currentChannelId) {
        stopRecording();
    }
}

// ─── Context Menu (JSX) ───────────────────────────────────────────────────────

const voiceChannelContextMenu: NavContextMenuPatchCallback = (children, props) => {
    // Only patch voice channel context menus (type 2 = GUILD_VOICE)
    if (!props?.channel || props.channel.type !== 2) return;

    children.push(
        <Menu.MenuSeparator key="nonnitroclips-sep" />,

        <Menu.MenuItem
            key="nonnitroclips-save"
            id="nonnitroclips-save"
            label="✂️ Save Clip"
            action={() => void saveClip()}
        />,

        <Menu.MenuItem
            key="nonnitroclips-toggle"
            id="nonnitroclips-toggle"
            label={settings.store.enabled ? "⏹ Stop Clip Recording" : "▶ Start Clip Recording"}
            action={() => {
                settings.store.enabled = !settings.store.enabled;
                if (!settings.store.enabled) {
                    stopRecording();
                } else {
                    const ch = SelectedChannelStore?.getVoiceChannelId?.();
                    if (ch) void startRecording(ch);
                }
            }}
        />
    );
};

// ─── Stable Flux Callback Reference ──────────────────────────────────────────

function onVoiceStateUpdates(payload: VoiceStatePayload): void {
    const entries: VoiceStateEntry[] = payload.voiceStates ?? [payload];
    entries.forEach(handleVoiceStateUpdate);
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "NoNitroClips",
    description:
        "Record a rolling audio/video buffer in voice channels and save clips instantly — no Nitro needed. Press Alt+C (configurable) to clip.",
    authors: [{ name: "You", id: 0n }],
    settings,

    // ── Webpack Patches ────────────────────────────────────────────────────
    patches: [
        /**
         * Remove "Clips is a Nitro feature" premium gate.
         * noWarn: true — this is a forward-compatibility patch; it silently
         * no-ops if Discord hasn't shipped the gate yet.
         */
        {
            find: "CLIPS_NITRO_UPSELL",
            replacement: {
                match: /\i\.isPremium\b[^}]+?CLIPS/,
                replace: "true /* NoNitroClips */",
            },
            noWarn: true,
        },

        /**
         * Bypass experiment / early-access eligibility check for Clips.
         */
        {
            find: '"clips"',
            replacement: {
                match: /isEligibleForClips\(\)/,
                replace: "true /* NoNitroClips */",
            },
            noWarn: true,
        },
    ],

    // ── Plugin Lifecycle ───────────────────────────────────────────────────

    start() {
        registerHotkey();
        addContextMenuPatch("channel-context", voiceChannelContextMenu);
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);

        // Begin recording immediately if already in a voice channel
        const existingChannel = SelectedChannelStore?.getVoiceChannelId?.();
        if (existingChannel && settings.store.enabled) {
            void startRecording(existingChannel);
        }

        console.info("[NoNitroClips] Started. Hotkey:", settings.store.hotkey);
    },

    stop() {
        stopRecording();
        unregisterHotkey();
        removeContextMenuPatch("channel-context", voiceChannelContextMenu);
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        console.info("[NoNitroClips] Stopped.");
    },
});
