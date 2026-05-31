/**
 * TPS Meter — Tokens Per Second
 *
 * Displays in footer status bar next to caveman level:
 *   TPS: 42.1 avg | μ 38.7 | p95 61.2
 *
 * - Rolling avg: last 60s window
 * - μ (mean): all-time average
 * - p95: 95th percentile of all recorded TPS values
 *
 * Uses character count / 4 as token estimate.
 * Fires on message_update (text_delta) and finalizes on message_end.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Config ---
const WINDOW_MS = 60_000; // 1 minute rolling window
const CHARS_PER_TOKEN = 4;
const UPDATE_INTERVAL_MS = 500; // throttle status bar updates

// --- State ---
interface StreamSample {
  tokens: number;
  endMs: number; // when this sample was recorded
}

let streamStartMs = 0;
let streamTokens = 0;
let lastUpdateMs = 0;

// Rolling window (last 60s)
const window: StreamSample[] = [];

// All-time for mean and p95
const allTime: number[] = []; // TPS values per assistant message

// --- Helpers ---

function now(): number {
  return Date.now();
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
}

function pruneWindow(): void {
  const cutoff = now() - WINDOW_MS;
  while (window.length > 0 && window[0].endMs < cutoff) {
    window.shift();
  }
}

function rollingTps(): number {
  pruneWindow();
  if (window.length === 0) return 0;
  const totalTokens = window.reduce((s, w) => s + w.tokens, 0);
  const spanMs = window[window.length - 1].endMs - window[0].endMs;
  if (spanMs < 100) return 0; // too short to measure
  return (totalTokens / spanMs) * 1000;
}

function meanTps(): number {
  if (allTime.length === 0) return 0;
  return allTime.reduce((a, b) => a + b, 0) / allTime.length;
}

function p95Tps(): number {
  if (allTime.length === 0) return 0;
  const sorted = [...allTime].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

function formatTps(v: number): string {
  return v < 10 ? v.toFixed(1) : v.toFixed(0);
}

function statusText(): string {
  const avg = rollingTps();
  const mu = meanTps();
  const p95 = p95Tps();
  if (avg === 0 && mu === 0) return "";
  return `TPS: ${formatTps(avg)} avg | μ ${formatTps(mu)} | p95 ${formatTps(p95)}`;
}

// --- Extension ---

export default function tpsMeter(pi: ExtensionAPI): void {

  // Reset on new assistant message
  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    streamStartMs = now();
    streamTokens = 0;
    lastUpdateMs = 0;
  });

  // Count tokens from stream deltas, update status bar periodically
  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!event.assistantMessageEvent) return;

    const evt = event.assistantMessageEvent;

    // Count text and thinking deltas
    if (evt.type === "text_delta" || evt.type === "thinking_delta") {
      const delta = evt.delta as string;
      streamTokens += estimateTokens(delta.length);
    }

    // Throttle status bar updates
    const t = now();
    if (t - lastUpdateMs < UPDATE_INTERVAL_MS) return;
    lastUpdateMs = t;

    // Live TPS during streaming
    const elapsed = (t - streamStartMs) / 1000;
    if (elapsed < 0.3) return; // avoid flicker at start

    const liveTps = streamTokens / elapsed;
    ctx.ui.setStatus("tps", ctx.ui.theme.fg("accent", `⚡ ${formatTps(liveTps)} tps`));
  });

  // Finalize: record TPS for this message, update rolling + all-time stats
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const elapsed = (now() - streamStartMs) / 1000;
    if (elapsed < 0.1 || streamTokens === 0) return;

    const tps = streamTokens / elapsed;

    // Record sample
    const sample: StreamSample = { tokens: streamTokens, endMs: now() };
    window.push(sample);
    allTime.push(tps);

    // Cap all-time history (keep last 500 measurements)
    if (allTime.length > 500) allTime.splice(0, allTime.length - 500);

    // Update status bar with aggregate stats
    const txt = statusText();
    if (txt) {
      ctx.ui.setStatus("tps", ctx.ui.theme.fg("accent", txt));
    }
  });

  // Clear on session start
  pi.on("session_start", async (_event, ctx) => {
    streamStartMs = 0;
    streamTokens = 0;
    lastUpdateMs = 0;
    window.length = 0;
    allTime.length = 0;
    ctx.ui.setStatus("tps", undefined);
  });
}
