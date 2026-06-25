# pi-tps-meter

Tokens per second meter for [pi CLI](https://pi.dev) with sparkline visualization.

## Install

```bash
pi install npm:pi-tps-meter
```

## Features

**During streaming** — live animated display:
```
⠋ ▓▓▓▓▓▓░░░░ 42 tps
```

**After message** — aggregate stats:
```
TPS: ▓▓▓▓ 42 | μ 39 | p95 61
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
