# bimmer-link: open-source licenses

`bimmer-link` is licensed under **GPL-3.0-or-later** (`LICENSE.GPL-3.0`).

For optional 360-degree Surround View remote snapshot capture (`cam360.js`), `bimmer-link` includes the `mgu-sidecam` AVB H.264 decoder helper (GPL-3.0-or-later), which incorporates:

- `waze-on-cluster/src/avb_source.*`, `rtp_h264.*`, `packet_queue.h`, and `cluster-render/src/log.*` from [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (GPL-3.0-or-later, Copyright (C) 2026 Robert Nisipeanu).
- `cluster-render/client/*` and `include/cluster_render/*` from [robertnisipeanu/idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (MPL-2.0, Copyright (C) 2026 Robert Nisipeanu; see `LICENSE.MPL-2.0`).
- FFmpeg 7.1 `libavcodec` and `libavutil` (H.264 decoder only, LGPL-2.1-or-later, built without GPL or nonfree components; see `LICENSE.ffmpeg`, source at https://github.com/FFmpeg/FFmpeg tag `n7.1`).
- GCC `libstdc++` and `libgcc` (GPL-3.0 with GCC Runtime Library Exception).
