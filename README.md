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

## Optimizations

- Single shared timer (no per-event timers)
- Fixed-size circular buffer (zero allocations in hot path)
- Bitwise token estimation
- 200ms update throttle during streaming
- Insertion sort for p95 (fast for ≤500 elements)

## Author

Venkata Sai Chirasani

## License

MIT
