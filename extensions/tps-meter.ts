/**
 * TPS Meter v3 — Tokens Per Second with Sparkline Trend
 *
 * Footer display:
 *   Streaming:  ⠹ ▁▂▃▅▇▆▅▃▂▁ 42 tps
 *   Complete:   TPS ▁▂▃▅▇▆▅▃▂▁ 42 avg | μ 39 | p95 61
 *
 * Features:
 *   - Real sparkline: ▁▂▃▄▅▆▇█ showing TPS trend over last 12 messages
 *   - Color-coded sparkline by speed
 *   - Animated spinner during streaming
 *   - Rolling 60s window for avg, all-time for μ and p95
 *
 * Accuracy:
 *   - Uses the provider's real output token count (message.usage.output);
 *     bitwise char/4 estimate is only a fallback for providers without usage
 *   - Rate measured from first token (excludes time-to-first-token latency)
 *
 * Optimizations:
 *   - Fixed ring buffers (no allocations in the streaming repaint path)
 *   - Memoized sparkline (rebuilt once per message, not every tick)
 *   - Single shared 200ms timer, torn down on message_end and agent_end
 *   - Insertion sort for p95 (cold path, ≤500 elements)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Config ---
const WINDOW_SIZE = 60;
const WINDOW_MS = 60_000;
const STREAM_INTERVAL_MS = 200;
const SPARK_LEN = 12;
const ALLTIME_CAP = 500;
const FAST = 50;
const MED = 20;

// --- Sparkline chars (8 levels) ---
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

// --- State ---
let streamStartMs = 0;
let firstTokenMs = 0; // when the first delta arrived (excludes TTFT from rate)
let streamChars = 0;
let streamTokens = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let streaming = false;

// Rolling window (circular buffer)
const winBuf = new Float64Array(WINDOW_SIZE * 2);
let winLen = 0;
let winHead = 0;

// All-time stats (circular buffer)
const atBuf = new Float64Array(ALLTIME_CAP);
let atLen = 0;
let atHead = 0;
let atSum = 0;

// Sparkline history (ring buffer of TPS values, last N messages)
const sparkBuf = new Float64Array(SPARK_LEN);
let sparkLen = 0;
let sparkHead = 0;
let sparkMax = 1; // track max for normalization
let sparkCache = ""; // memoized rendered sparkline (only changes once per message)
let sparkDirty = true;
let sparkTheme: unknown = null; // invalidate cache if the theme changes mid-session

// --- Helpers ---

function now(): number {
  return Date.now();
}

function tokEst(ch: number): number {
  return (ch >>> 2) + ((ch & 3) > 0 ? 1 : 0);
}

function winPush(tps: number, ms: number): void {
  const b = winHead * 2;
  winBuf[b] = tps;
  winBuf[b + 1] = ms;
  winHead = (winHead + 1) % WINDOW_SIZE;
  if (winLen < WINDOW_SIZE) winLen++;
}

function atPush(tps: number): void {
  atSum += tps;
  if (atLen >= ALLTIME_CAP) atSum -= atBuf[atHead];
  atBuf[atHead] = tps;
  atHead = (atHead + 1) % ALLTIME_CAP;
  if (atLen < ALLTIME_CAP) atLen++;
}

function sparkPush(tps: number): void {
  sparkBuf[sparkHead] = tps;
  sparkHead = (sparkHead + 1) % SPARK_LEN;
  if (sparkLen < SPARK_LEN) sparkLen++;
  if (tps > sparkMax) sparkMax = tps;
  // Decay max slowly so sparkline adapts
  if (sparkMax > 10) sparkMax *= 0.99;
  sparkDirty = true;
}

function winAvg(): number {
  if (winLen === 0) return 0;
  const cutoff = now() - WINDOW_MS;
  let sum = 0;
  let n = 0;
  const oldest = winLen < WINDOW_SIZE ? 0 : winHead;
  for (let i = 0; i < winLen; i++) {
    const idx = (oldest + i) % WINDOW_SIZE;
    const b = idx * 2;
    if (winBuf[b + 1] < cutoff) continue;
    sum += winBuf[b];
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

function atMean(): number {
  return atLen === 0 ? 0 : atSum / atLen;
}

function atP95(): number {
  if (atLen === 0) return 0;
  const tmp = new Float64Array(atLen);
  const oldest = atLen < ALLTIME_CAP ? 0 : atHead;
  for (let i = 0; i < atLen; i++) tmp[i] = atBuf[(oldest + i) % ALLTIME_CAP];
  // Insertion sort
  for (let i = 1; i < tmp.length; i++) {
    const v = tmp[i];
    let j = i - 1;
    while (j >= 0 && tmp[j] > v) {
      tmp[j + 1] = tmp[j];
      j--;
    }
    tmp[j + 1] = v;
  }
  return tmp[Math.ceil(tmp.length * 0.95) - 1] || 0;
}

function fmt(v: number): string {
  if (v < 10) return v.toFixed(1);
  if (v < 100) return v.toFixed(0);
  return `${Math.round(v)}`;
}

// --- Sparkline rendering ---

function sparkline(theme: any): string {
  // Sparkline data only changes once per message (sparkPush), so memoize the
  // rendered string instead of re-allocating + recoloring on every 200ms tick.
  // Invalidate if the active theme changed (user switched themes mid-session).
  if (theme !== sparkTheme) {
    sparkDirty = true;
    sparkTheme = theme;
  }
  if (!sparkDirty) return sparkCache;

  if (sparkLen === 0) {
    sparkCache = theme.fg("dim", "▁".repeat(SPARK_LEN));
    sparkDirty = false;
    return sparkCache;
  }

  // Read ring buffer in order (oldest first)
  const vals = new Float64Array(SPARK_LEN);
  const oldest = sparkLen < SPARK_LEN ? 0 : sparkHead;
  for (let i = 0; i < sparkLen; i++) {
    vals[i] = sparkBuf[(oldest + i) % SPARK_LEN];
  }

  // Normalize against local max
  let localMax = 1;
  for (let i = 0; i < sparkLen; i++) {
    if (vals[i] > localMax) localMax = vals[i];
  }
  // Also consider historical max
  if (sparkMax > localMax) localMax = sparkMax;

  let result = "";
  for (let i = 0; i < SPARK_LEN; i++) {
    const v = vals[i];
    const norm = Math.min(7, Math.round((v / localMax) * 7));
    const ch = BLOCKS[norm];

    // Color each block by speed
    let colored: string;
    if (v >= FAST) colored = theme.fg("success", ch);
    else if (v >= MED) colored = theme.fg("warning", ch);
    else colored = theme.fg("error", ch);

    result += colored;
  }
  sparkCache = result;
  sparkDirty = false;
  return result;
}

// --- Spinner ---

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinI = 0;
function spin(): string {
  const s = SPIN[spinI];
  spinI = (spinI + 1) % SPIN.length;
  return s;
}

function speedColor(tps: number, text: string, theme: any): string {
  if (tps >= FAST) return theme.fg("success", text);
  if (tps >= MED) return theme.fg("warning", text);
  return theme.fg("error", text);
}

// --- Rendering ---

function renderLive(theme: any): string {
  // Measure generation rate from the first token, not from message_start, so
  // network/queue latency (TTFT) doesn't drag the reported speed down.
  const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
  const elapsed = (now() - ref) / 1000;
  const tps = elapsed > 0.3 ? streamTokens / elapsed : 0;
  const s = spin();
  const sp = sparkline(theme);
  const num = speedColor(tps, `${fmt(tps)} tps`, theme);
  return `${theme.fg("accent", s)} ${sp} ${num}`;
}

function renderFinal(theme: any): string {
  const avg = winAvg();
  const mu = atMean();
  const p95 = atP95();
  if (avg === 0 && mu === 0) return "";

  const sp = sparkline(theme);
  const a = speedColor(avg, fmt(avg), theme);
  const m = speedColor(mu, `μ ${fmt(mu)}`, theme);
  const p = speedColor(p95, `p95 ${fmt(p95)}`, theme);

  return `TPS ${sp} ${a} avg | ${m} | ${p}`;
}

// --- Single shared timer ---

function startTick(ctx: any, theme: any): void {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (!streaming) {
      stopTick();
      return;
    }
    ctx.ui.setStatus("tps", renderLive(theme));
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

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    streamStartMs = now();
    firstTokenMs = 0;
    streamChars = 0;
    streamTokens = 0;
    streaming = true;
    spinI = 0;
    startTick(ctx, ctx.ui.theme);
  });

  pi.on("message_update", async (event) => {
    if (event.message.role !== "assistant") return;
    if (!event.assistantMessageEvent) return;
    const evt = event.assistantMessageEvent;
    if (evt.type === "text_delta" || evt.type === "thinking_delta") {
      const d = evt.delta as string;
      if (!d) return;
      if (firstTokenMs === 0) firstTokenMs = now();
      streamChars += d.length;
      streamTokens = tokEst(streamChars);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    streaming = false;
    stopTick();

    // Prefer the provider's real output token count; fall back to the char
    // estimate only when usage is unavailable (e.g. some local providers).
    const realOut = event.message?.usage?.output;
    const tokens =
      typeof realOut === "number" && realOut > 0 ? realOut : streamTokens;

    // Rate is generation-only: from first token to end, excluding TTFT.
    const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
    const elapsed = (now() - ref) / 1000;
    if (elapsed < 0.1 || tokens === 0) return;

    const tps = tokens / elapsed;

    // Record to all buffers
    winPush(tps, now());
    atPush(tps);
    sparkPush(tps);

    const txt = renderFinal(ctx.ui.theme);
    if (txt) ctx.ui.setStatus("tps", txt);
  });

  // Safety net: if a stream is aborted (Esc/Ctrl-C) or errors, message_end may
  // not fire for that message — agent_end always does. Without this the 200ms
  // timer would keep repainting a stale live number indefinitely.
  pi.on("agent_end", async () => {
    streaming = false;
    stopTick();
  });

  pi.on("session_start", async (_event, ctx) => {
    streaming = false;
    stopTick();
    streamStartMs = 0;
    firstTokenMs = 0;
    streamChars = 0;
    streamTokens = 0;
    winLen = 0;
    winHead = 0;
    atLen = 0;
    atHead = 0;
    atSum = 0;
    sparkLen = 0;
    sparkHead = 0;
    sparkMax = 1;
    sparkCache = "";
    sparkDirty = true;
    sparkTheme = null;
    spinI = 0;
    ctx.ui.setStatus("tps", undefined);
  });
}
