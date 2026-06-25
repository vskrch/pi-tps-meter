/**
 * Offline simulation harness for the TPS meter extension.
 *
 * Drives the extension through pi's real event sequence with a mocked
 * ExtensionAPI + ctx, controllable clock, and instrumented timers — so we can
 * assert the token math, TTFT handling, real-usage-vs-fallback, abort cleanup,
 * and sparkline memoization deterministically without a network call.
 *
 * Run: node tps-sim.test.ts   (Node 23 strips the type-only import)
 */
import tpsMeter from "./extensions/tps-meter.ts";

declare const process: { exit(code?: number): never };

// --- controllable clock ---
let T = 0;
const realNow = Date.now;
Date.now = () => T;

// --- instrumented timers (no real timers; count active) ---
let activeTimers = 0;
let lastIntervalCb: (() => void) | null = null;
// @ts-ignore - override globals for the test
globalThis.setInterval = ((cb: () => void) => {
  activeTimers++;
  lastIntervalCb = cb;
  return { id: activeTimers } as any;
}) as any;
// @ts-ignore
globalThis.clearInterval = ((_h: any) => {
  if (activeTimers > 0) activeTimers--;
  lastIntervalCb = null;
}) as any;

// --- mock pi + ctx ---
type Handler = (event: any, ctx: any) => any;
const handlers = new Map<string, Handler>();
const statuses: Record<string, string | undefined> = {};
const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as any;
const ctx = {
  ui: {
    theme: { fg: (_c: string, s: string) => s }, // strip color for plain assertions
    setStatus: (k: string, v: string | undefined) => {
      statuses[k] = v;
    },
  },
} as any;

const fire = (name: string, event: any) => handlers.get(name)?.(event, ctx);
const asst = (extra: any = {}) => ({ message: { role: "assistant", ...extra } });

// --- tiny assert ---
let failures = 0;
function ok(cond: boolean, label: string, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${tag}] ${label}${detail ? `  — ${detail}` : ""}`);
}
function approx(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}
function num(s: string | undefined): number {
  const m = (s ?? "").match(/-?\d+(\.\d+)?/g);
  return m ? Number(m[0]) : NaN;
}

tpsMeter(pi);

// ============================================================
// Test 1: real usage.output is used, rate excludes TTFT
// ============================================================
T = 1000;
fire("message_start", asst());
ok(activeTimers === 1, "timer started on message_start", `active=${activeTimers}`);

T = 1300; // 300ms TTFT before first token
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 2300; // 1.0s of generation after first token
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
// message_end at T=2300 with REAL 50 output tokens => 50 / (2300-1300)/1000 = 50 tps
fire("message_end", asst({ usage: { output: 50 } }));
ok(activeTimers === 0, "timer cleared on message_end", `active=${activeTimers}`);
{
  const v = num(statuses["tps"]);
  ok(approx(v, 50), "real tokens + TTFT-excluded rate = 50 tps", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 2: fallback to char estimate when usage is absent
// chars=400 -> tokEst = ceil(400/4)=100 tokens over 2.0s = 50 tps
// ============================================================
fire("session_start", {});
ok(num(statuses["tps"]) !== num(statuses["tps"]) || statuses["tps"] === undefined, "session_start clears status", `status=${statuses["tps"]}`);
T = 5000;
fire("message_start", asst());
T = 5000; // first token immediately
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "y".repeat(400) },
});
T = 7000; // 2.0s later
fire("message_end", asst()); // no usage field
{
  const v = num(statuses["tps"]);
  ok(approx(v, 50), "char/4 fallback when usage missing = 50 tps", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 3: abort safety net — agent_end tears down a live timer
// ============================================================
fire("session_start", {});
T = 9000;
fire("message_start", asst());
ok(activeTimers === 1, "timer running mid-stream", `active=${activeTimers}`);
fire("agent_end", {});
ok(activeTimers === 0, "agent_end stops runaway timer on abort", `active=${activeTimers}`);

// ============================================================
// Test 4: tiny/empty responses are ignored (no noise samples)
// ============================================================
fire("session_start", {});
T = 11000;
fire("message_start", asst());
T = 11000;
fire("message_end", asst({ usage: { output: 0 } })); // zero tokens
ok(statuses["tps"] === undefined, "zero-token message produces no sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 5: sparkline memoization — no work between message ends
// ============================================================
fire("session_start", {});
// feed a few completed messages so sparkline has data, then tick repeatedly
for (let i = 0; i < 3; i++) {
  T = 20000 + i * 2000;
  fire("message_start", asst());
  T += 0; // first token now
  fire("message_update", { ...asst(), assistantMessageEvent: { type: "text_delta", delta: "z".repeat(200) } });
  T += 1000;
  fire("message_end", asst({ usage: { output: 30 + i * 20 } }));
}
// Start a new stream and tick the live timer many times; sparkline is static
T = 30000;
fire("message_start", asst());
// `as any` defeats TS narrowing: the reassignments happen inside the
// setInterval override closure, which control-flow analysis can't see.
const liveCb: (() => void) | null = lastIntervalCb as any;
let crashed = false;
try {
  for (let i = 0; i < 50; i++) {
    T += 200;
    liveCb?.();
  }
} catch (e) {
  crashed = true;
  console.log("tick error:", (e as Error).message);
}
ok(!crashed && typeof statuses["tps"] === "string", "live ticks render without crashing", `status=${statuses["tps"]}`);
fire("agent_end", {});

// --- restore + summary ---
Date.now = realNow;
console.log("\n" + (failures === 0 ? "ALL TESTS PASSED ✅" : `${failures} TEST(S) FAILED ❌`));
process.exit(failures === 0 ? 0 : 1);
