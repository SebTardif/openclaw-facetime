# FaceTime Helper

Standalone macOS helper bundle for FaceTime call-control events.

The helper connects directly to the OpenClaw `facetime` plugin over newline-delimited JSON on:

```text
localhost:45670 + uid - 501
```

It emits `ft-call-status-changed` events and accepts existing actions such as `answer-call` and `leave-call`.
