# pi-tps-meter

Tokens per second meter for [pi CLI](https://pi.dev) with sparkline visualization.

## Install

```bash
pi install npm:pi-tps-meter
```

## Features

**During streaming** — a smooth, animated gauge that fills with live speed
(1/8-cell resolution, auto-scaled to your session's peak):
```
⠹ ▕███████▋···▏ 47 tps
```

**After a message** — a min-max normalized sparkline of your last 12 messages
(newest on the right) plus aggregate stats:
```
▁▄▇▅▂▁▇█▅▃▆▇ 42 tps · μ 39 · p95 61
```

**Color coding:**
- 🟢 Green: >50 tps (fast)
- 🟡 Yellow: 20-50 tps (medium)
- 🔴 Red: <20 tps (slow)

## Accuracy

- Uses the provider's **real** output token count (`message.usage.output`); the
  bitwise char/4 estimate is only a fallback for providers that don't report usage
- Rate is measured from the **first token**, so time-to-first-token (network/queue
  latency) doesn't drag down the reported tps

## Optimizations

- Single shared 200ms timer, torn down on both `message_end` and `agent_end`
  (no runaway timer if a stream is aborted)
- Fixed-size circular buffers (no allocations in the streaming repaint path)
- Memoized sparkline (rebuilt once per message, not on every tick)
- Insertion sort for p95 (cold path, runs once per message for ≤500 elements)

## Author

Venkata Sai Chirasani

## License

MIT
