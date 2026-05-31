/**
 * TPS Meter v2 — Tokens Per Second
 *
 * Footer display:
 *   Streaming:  ⚡ ▓▓▓▓▓▓░░░░ 42 tps
 *   Complete:   TPS: ▓▓▓▓ 42 avg | μ 39 | p95 61
 *
 * Features:
 *   - Live sparkline bar during streaming (10-char width)
 *   - Color-coded: green (>50), yellow (20-50), red (<20)
 *   - Rolling 60s window for avg, all-time for μ and p95
 *   - Token estimate: chars / 4
 *
 * Resource optimization:
 *   - Single shared timer (no per-event timers)
 *   - Fixed-size circular buffer for window samples
 *   - Minimal allocations in hot path
 *   - Throttled updates: 200ms streaming, 0ms on finalize
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Config ---
const WINDOW_SIZE = 60; // max samples in rolling window
const WINDOW_MS = 60_000;
const CHARS_PER_TOKEN = 4;
const STREAM_INTERVAL_MS = 200; // update freq during streaming
const SPARK_WIDTH = 10; // sparkline bar width
const ALLTIME_CAP = 500;

// --- Speed thresholds ---
const FAST = 50;
const MED = 20;

// --- State ---
let streamStartMs = 0;
let streamChars = 0;
let streamTokens = 0;
let lastTickMs = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let streaming = false;

// Circular buffer for rolling window (fixed size, no allocations)
const windowBuf = new Float64Array(WINDOW_SIZE * 2); // [tps, endMs] pairs
let windowLen = 0;
let windowHead = 0;

// All-time stats (ring buffer)
const allTimeBuf = new Float64Array(ALLTIME_CAP);
let allTimeLen = 0;
let allTimeHead = 0;
let allTimeSum = 0;

// --- Helpers ---

function now(): number {
  return Date.now();
}

function estimateTokens(chars: number): number {
  return (chars >>> 2) + ((chars & 3) > 0 ? 1 : 0); // ceil(chars/4) via bit ops
}

// Circular buffer push
function windowPush(tps: number, endMs: number): void {
  const base = windowHead * 2;
  windowBuf[base] = tps;
  windowBuf[base + 1] = endMs;
  windowHead = (windowHead + 1) % WINDOW_SIZE;
  if (windowLen < WINDOW_SIZE) windowLen++;
}

function allTimePush(tps: number): void {
  allTimeSum += tps;
  // Subtract old value if buffer is full
  if (allTimeLen >= ALLTIME_CAP) {
    allTimeSum -= allTimeBuf[allTimeHead];
  }
  allTimeBuf[allTimeHead] = tps;
  allTimeHead = (allTimeHead + 1) % ALLTIME_CAP;
  if (allTimeLen < ALLTIME_CAP) allTimeLen++;
}

function rollingAvg(): number {
  if (windowLen === 0) return 0;
  const cutoff = now() - WINDOW_MS;
  let totalTokens = 0;
  let firstMs = Infinity;
  let lastMs = 0;
  let count = 0;

  // Walk circular buffer
  const oldest = windowLen < WINDOW_SIZE ? 0 : windowHead;
  for (let i = 0; i < windowLen; i++) {
    const idx = (oldest + i) % WINDOW_SIZE;
    const base = idx * 2;
    const endMs = windowBuf[base + 1];
    if (endMs < cutoff) continue;
    const tps = windowBuf[base];
    // Estimate tokens from tps (we don't store tokens directly)
    // Approximate: tps * timeBetweenSamples ≈ tokens
    totalTokens += tps; // we'll divide by count for avg
    if (endMs < firstMs) firstMs = endMs;
    if (endMs > lastMs) lastMs = endMs;
    count++;
  }

  if (count === 0) return 0;
  // Return average TPS of recent samples
  return totalTokens / count;
}

function allTimeMean(): number {
  return allTimeLen === 0 ? 0 : allTimeSum / allTimeLen;
}

function allTimeP95(): number {
  if (allTimeLen === 0) return 0;

  // Copy valid entries to temp array for sorting
  const temp = new Float64Array(allTimeLen);
  const oldest = allTimeLen < ALLTIME_CAP ? 0 : allTimeHead;
  for (let i = 0; i < allTimeLen; i++) {
    temp[i] = allTimeBuf[(oldest + i) % ALLTIME_CAP];
  }

  // Insertion sort (fast for small arrays)
  for (let i = 1; i < temp.length; i++) {
    const val = temp[i];
    let j = i - 1;
    while (j >= 0 && temp[j] > val) {
      temp[j + 1] = temp[j];
      j--;
    }
    temp[j + 1] = val;
  }

  const idx = Math.ceil(temp.length * 0.95) - 1;
  return temp[Math.max(0, idx)];
}

function fmt(v: number): string {
  return v < 10 ? v.toFixed(1) : v < 100 ? v.toFixed(0) : `${Math.round(v)}`;
}

// Speed-based color
function speedColor(tps: number, text: string, theme: any): string {
  if (tps >= FAST) return theme.fg("success", text);
  if (tps >= MED) return theme.fg("warning", text);
  return theme.fg("error", text);
}

// Sparkline bar: ▓ fast, ▒ medium, ░ slow
function sparkBar(tps: number, theme: any): string {
  if (tps <= 0) return theme.fg("dim", "░".repeat(SPARK_WIDTH));

  // Map 0-100 tps to 0-10 width
  const fill = Math.min(SPARK_WIDTH, Math.round((tps / 100) * SPARK_WIDTH));
  const empty = SPARK_WIDTH - fill;

  let bar = "";
  if (tps >= FAST) {
    bar = theme.fg("success", "▓".repeat(fill)) + theme.fg("dim", "░".repeat(empty));
  } else if (tps >= MED) {
    bar = theme.fg("warning", "▓".repeat(fill)) + theme.fg("dim", "░".repeat(empty));
  } else {
    bar = theme.fg("error", "▓".repeat(fill)) + theme.fg("dim", "░".repeat(empty));
  }
  return bar;
}

// Streaming spinner frames
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinIdx = 0;
function spinFrame(): string {
  const s = SPIN[spinIdx];
  spinIdx = (spinIdx + 1) % SPIN.length;
  return s;
}

// --- Status rendering ---

function renderStreaming(theme: any): string {
  const elapsed = (now() - streamStartMs) / 1000;
  const tps = elapsed > 0.3 ? streamTokens / elapsed : 0;
  const spin = spinFrame();
  const bar = sparkBar(tps, theme);
  const num = speedColor(tps, `${fmt(tps)} tps`, theme);
  return `${theme.fg("accent", spin)} ${bar} ${num}`;
}

function renderComplete(theme: any): string {
  const avg = rollingAvg();
  const mu = allTimeMean();
  const p95 = allTimeP95();
  if (avg === 0 && mu === 0) return "";

  const bar = sparkBar(avg, theme);
  const avgStr = speedColor(avg, fmt(avg), theme);
  const muStr = speedColor(mu, `μ ${fmt(mu)}`, theme);
  const p95Str = speedColor(p95, `p95 ${fmt(p95)}`, theme);

  return `TPS: ${bar} ${avgStr} | ${muStr} | ${p95Str}`;
}

// --- Tick loop (single timer for all updates) ---

function startTick(ctx: any, theme: any): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!streaming) {
      stopTick();
      return;
    }
    ctx.ui.setStatus("tps", renderStreaming(theme));
  }, STREAM_INTERVAL_MS);
}

function stopTick(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// ============================
// Extension
// ============================

export default function tpsMeter(pi: ExtensionAPI): void {

  // New assistant message — start counting
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    streamStartMs = now();
    streamChars = 0;
    streamTokens = 0;
    lastTickMs = 0;
    streaming = true;
    spinIdx = 0;

    startTick(ctx, ctx.ui.theme);
  });

  // Accumulate tokens from stream deltas
  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!event.assistantMessageEvent) return;

    const evt = event.assistantMessageEvent;
    if (evt.type === "text_delta" || evt.type === "thinking_delta") {
      const delta = evt.delta as string;
      streamChars += delta.length;
      streamTokens = estimateTokens(streamChars);
    }
  });

  // Message done — finalize stats
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    streaming = false;
    stopTick();

    const elapsed = (now() - streamStartMs) / 1000;
    if (elapsed < 0.1 || streamTokens === 0) return;

    const tps = streamTokens / elapsed;

    // Record to circular buffers
    windowPush(tps, now());
    allTimePush(tps);

    // Show final stats
    const txt = renderComplete(ctx.ui.theme);
    if (txt) {
      ctx.ui.setStatus("tps", txt);
    }
  });

  // Clear on session start
  pi.on("session_start", async (_event, ctx) => {
    streaming = false;
    stopTick();
    streamStartMs = 0;
    streamChars = 0;
    streamTokens = 0;
    windowLen = 0;
    windowHead = 0;
    allTimeLen = 0;
    allTimeHead = 0;
    allTimeSum = 0;
    spinIdx = 0;
    ctx.ui.setStatus("tps", undefined);
  });
}
