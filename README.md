# pi-tps-meter

Tokens per second meter for [pi CLI](https://pi.dev).

## Install

```bash
pi install npm:pi-tps-meter
```

## Usage

Footer shows live stats during and after streaming:

```
⚡ 42 tps          (during streaming, updates every 500ms)
TPS: 42 avg | μ 39 | p95 61   (after message completes)
```

- **avg** — rolling average over last 60 seconds
- **μ** — all-time mean
- **p95** — 95th percentile of all measurements

No config needed. Works out of the box.

## Author

Venkata Sai Chirasani

## License

MIT
