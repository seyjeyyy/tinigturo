# Speech recognition: investigation, capabilities and status

## Summary

| Engine | Where audio goes | Offline | Partials | Status in this build |
|---|---|---|---|---|
| Browser Web Speech, on-device (`processLocally`) | Stays on device | Yes, once the browser's language pack is installed | Yes | **Used automatically when the browser reports `available`.** Not yet verified on target devices. |
| Browser Web Speech, cloud | Sent to the browser vendor (Google for Chrome, Apple for Safari) | No | Yes | **Off by default.** An adult must enable "Allow online word checking"; disclosed in the UI. Never a silent fallback. |
| Vosk (Kaldi WASM, `vosk-browser`) | Stays on device | Yes, after downloading a model | Yes | **Experimental, disabled by default** (`VITE_ENABLE_VOSK`). Not benchmarked on target devices. |
| None | Nothing processed | — | — | Reading and recording still work. "Practice saved—word assessment unavailable." |

English is the only language with automatic word checking. **Filipino stays
unassessed** (`LANGUAGES.fil.assessmentVerified = false`) until an engine has been
tested on Filipino child speech. Filipino is never scored with an English recognizer.
Filipino stories can still be read, recorded, listened to (where a Filipino voice
exists) and used for vocabulary.

## Capability detection

`src/speech/capabilities.ts` checks each of these separately:

- Microphone permission: `navigator.permissions` (granted, prompt, denied or
  unsupported).
- Recording: `MediaRecorder.isTypeSupported` over `audio/webm;codecs=opus`,
  `audio/webm`, `audio/mp4…` and `audio/ogg…`.
- Online recognition: whether `SpeechRecognition` / `webkitSpeechRecognition` exists.
- On-device recognition: `SpeechRecognition.available({ langs, processLocally: true })`
  (or the older `availableOnDevice`). Only a browser that implements this check is
  trusted to keep audio local.
- Language resources: on-device status `downloadable` offers "Download language pack"
  (`SpeechRecognition.install`). Vosk reports whether its model is in the
  `tinigturo-speech-models` cache.
- Speech synthesis voices for Listen mode and Word Coach.

`src/speech/plan.ts` then picks a plan. A downloaded on-device WASM engine comes first,
then browser on-device recognition, then cloud recognition (only if allowed and
online). Otherwise there is no assessment. Tests: `src/speech/plan.test.ts`.

### Browser defect found in testing

In the headless Chromium used for automated tests, calling
`SpeechRecognition.available({ processLocally: true })` **crashed the renderer**. The
app now writes an "in progress" marker before the check. If a later page load finds an
unfinished marker, the check is recorded as crashed and never run automatically again;
"Check again" on Offline downloads clears it. It is covered by
`e2e/speech-probe.spec.ts` and `src/speech/webSpeech.test.ts`. Whether release Chrome
on target devices is affected is **unknown** and must be checked on real hardware.

## Provider interface

`src/speech/types.ts` defines `SpeechProvider`: start, pause, resume, newSegment and
stop. Engines emit `SegmentUpdate { segmentId, text, isFinal }`, where segment text may
be revised until it is final. The reading UI and aligner depend only on this interface.
Adding an engine means one new class plus a branch in `createProvider`.

## Where the processing runs

- Recognition runs inside the browser's speech service or, for Vosk, in the engine's
  own Web Worker. Audio is captured for Vosk with an AudioWorklet (audio thread).
- Alignment runs on the main thread. Measured cost on the development machine (Intel
  i5-13420H, Node 24, `node scripts/bench-alignment.mjs`):

  | Passage | Updates | Mean per update | p95 | Max |
  |---|---|---|---|---|
  | 115 words, clean | 115 | 0.031 ms | 0.043 ms | 0.45 ms |
  | 115 words, 15% disfluencies | 110 | 0.037 ms | 0.062 ms | 0.47 ms |
  | 575 words, clean | 575 | 0.086 ms | 0.147 ms | 0.38 ms |
  | 575 words, 15% disfluencies | 552 | 0.103 ms | 0.243 ms | 0.45 ms |

  Even a device 20–50× slower stays at a few milliseconds per update, so a worker
  would add complexity without a measurable benefit. **Re-measure on target devices.**

## Package status (checked 2026-10-16)

Checked on the npm registry (`npm view`) and with `npm audit`, not from memory.

| Package | Version in use | Latest | Last published | Licence | Audit |
|---|---|---|---|---|---|
| `vosk-browser` | 0.0.8 | 0.0.8 | 2022-12-25 | Apache-2.0 | 2 moderate, both `uuid` (v3/v5/v6 caller-buffer bounds check), in code paths Vosk does not use |

No engine was changed in this release. Vosk stays experimental and disabled by default
(`VITE_ENABLE_VOSK`). An engine that has code in the app is not enabled just because the
code exists. Before switching to a maintained engine such as sherpa-onnx, check its
current releases, licence and security advisories from its official sources, then run
the benchmark below on target phones.

Benchmarks still to run on representative low-cost phones (none measured yet):

| Measure | How |
|---|---|
| Model download size and time | Offline downloads screen; note the network |
| Model load time and memory | `/benchmark`: load time and JS heap |
| Recognition latency, real-time factor | `/benchmark` on a consented recording |
| Battery and heat during a 5-minute reading | Device battery stats before and after |
| Recording and recognition together | Read aloud with the engine on; check the recording is complete |
| Accuracy | Word-by-word comparison with a teacher's reviewed transcript |

## Vosk evaluation notes (not yet a commitment)

| Item | Value |
|---|---|
| Package | `vosk-browser` 0.0.8 (Apache-2.0). Last release 2022; bundles an old `uuid` (moderate advisory for v3/v5/v6 buffer use, which Vosk does not use). |
| Engine bundle | 5.8 MB JS with embedded WASM (2.3 MB gzip). Code-split; cached only when the model is downloaded. |
| Model | Vosk small English (`vosk-model-small-en-us-0.15`), about 40 MB, Apache-2.0. Host it yourself and set `VITE_VOSK_MODEL_URL_EN`. |
| Languages | Official models exist for English and many others. **No Tagalog/Filipino model was found**, so Filipino stays unassessed. |
| Memory / latency / accuracy on target devices | **Not measured.** Use the benchmark screen below. |

Maintained alternatives worth evaluating before committing:

- **sherpa-onnx** (k2-fsa, Apache-2.0): streaming Zipformer models with WASM builds;
  actively maintained.
- **Whisper via transformers.js**: high accuracy but not streaming. Better suited to
  assessing saved recordings later than to live following, and heavy for low-cost
  devices.

### How to benchmark on a target device

1. Build with `VITE_ENABLE_VOSK=true` and `VITE_VOSK_MODEL_URL_EN=<your model URL>`.
2. On the device, open Offline downloads and download the speech model. Note the size.
3. Open `/benchmark`, choose the story and a consented recording of a child reading it,
   and run the benchmark.
4. Record model load time, real-time factor (must be < 1 for live following), JS heap,
   and words matched, for each device and model. Compare with a teacher's hand count.
5. Repeat in a typical classroom noise level.

Record the results here before enabling the engine by default.

## Recording and recognition at the same time

Browser recognition opens its own microphone capture. Recent Chrome accepts the
recording's `MediaStreamTrack` in `start(track)`, which the app passes when it can.
On some Android builds, recording and recognition together may fail with
`audio-capture`. The app then keeps recording, says "Word following stopped," and
marks the attempt for review.

## Browser and device matrix

Expected behaviour based on the APIs each browser documents. Rows marked *tested*
were run here; everything else **must be verified on real devices**.

| Browser / device | Install (PWA) | Offline app | Recording format | On-device recognition | Cloud recognition | TTS word timing |
|---|---|---|---|---|---|---|
| Chromium headless (CI) — *tested* | — | Yes (tested) | webm/opus (tested) | Check crashes; guarded (tested) | Present, off by default | No voices |
| Chrome desktop (Windows, ChromeOS) | Yes | Yes | webm/opus | Where Chrome reports `available` | Google, opt-in | Usually word boundaries |
| Chrome Android | Yes | Yes | webm/opus | Device-dependent | Google, opt-in | Often sentence only (fallback shown) |
| Edge desktop | Yes | Yes | webm/opus | Unknown | Microsoft, opt-in | Usually word boundaries |
| Safari iOS / iPadOS 17+ | Add to Home Screen | Yes | mp4/aac | No `available` check, so treated as not on-device | Apple, opt-in | Varies |
| Firefox | No install prompt | Yes | ogg/opus or webm | No | No Web Speech recognition | Varies |
