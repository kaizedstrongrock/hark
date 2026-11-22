# Benchmark

Everything here uses the app's own modules, so the numbers describe exactly what ships.

1. `yamnet-cache.mjs` runs the real YAMNet model (MediaPipe, in headless Chromium) over all 2,000
   ESC-50 clips, using the app's windowing (0.975 s every 0.5 s), and caches the scores in `cache/`
   (git-ignored, ~13 MB).
2. `evaluate.mjs` (pure Node):
   - **A. Built-in alerts:** grid-searches threshold × hits per alert on folds 1–3 (F1; F2 for urgent
     alerts, where a miss is worse than a false alarm), then reports recall, precision and false-alarm
     rate on held-out folds 4–5. Each clip is followed by 5 s of quiet, as in continuous listening.
   - **B. Alarm cadence:** counts T3/T4 detections and smoke/CO pages across all 2,000 clips (none of
     which is a smoke or CO alarm).
   - **C. Teach-a-sound:** for each of the 50 classes × 5 random trials, trains on 3 clips ("recordings")
     with 10 random clips of other classes as the home's background, then tests on the remaining 37
     clips plus 200 unseen clips of other classes.

```bash
node bench/yamnet-cache.mjs --esc50 /path/to/ESC-50-master
node bench/evaluate.mjs --esc50 /path/to/ESC-50-master --write   # updates results/esc50.json
```

ESC-50: K. J. Piczak. *ESC: Dataset for Environmental Sound Classification.* ACM Multimedia 2015.
https://github.com/karolpiczak/ESC-50 (CC BY-NC 3.0; used for evaluation only, not redistributed).
