# Fluxlink

Unofficial **Broadcast Box–backed screen sharing and plugin host for the Fluxer
desktop client**, with a cross-platform CDP injector that works with current
(V2) Fluxer builds.

> **Experimental public test build.** The injector, Broadcast Box publish path,
> plugin viewer, mirror mode and plugin store are verified on Linux against
> Fluxer `2026.1015.145325`. Stock-viewer tile/preview behavior in `bb` mode is
> still under investigation; use `uncapped` or `mirror` when testing with an
> unmodded client.

Status:

- ✅ injector attaches to Fluxer `2026.1015.145325` (Electron 44.4.1) and patches the live renderer
- ✅ `getDisplayMedia` capture hook installed in the app's main world
- ✅ panel UI mounts inside Fluxer; broadcast button in the call controls (native styling)
- ✅ Broadcast Box reachable from the app origin (CORS `*`): `GET /api/status` → 200, `POST /api/whep` → 400 for a dummy SDP
- ✅ **publish path**: synthetic capture → placeholder returned to Fluxer → real stream published to BB over WHIP → server reports it live
- ✅ **viewer path**: a screen-share tile is detected, WHEP-subscribed and swapped in place → **1920×1080 H264 decoded**, restored when the broadcast ends
- ✅ **real screen picker**: verified end-to-end (real capture → placeholder → WHIP → WHEP decode at 1920×1080, two concurrent plugin viewers)
- ✅ **hardware encode**: H264 on the GPU at 59 fps @1080p, after working around a Mesa/radeonsi keyframe bug
- ✅ **plugin store**: local install/remove/enable API, built-in index + any HTTPS index URL,
  two example plugins (stats overlay, panel hotkey)
- ✅ **Settings → Plugins page**: embedded native settings page with repo index input,
  installed list + enable/disable toggles, and an Available list with install buttons
- 🧪 **mirror an existing Broadcast Box stream**: paste an OBS/WHIP stream key or URL,
  subscribe over WHEP, and start a normal Fluxer screen share from that feed
  (simulated end-to-end; real-OBS validation still pending)
- ✅ **cross-platform launcher**: Node-only, with Fluxer autodetection on Windows,
  Linux and macOS

---

## Why not BetterFluxer?

BetterFluxer's last commit is **21 Mar 2026**; Reflux and Midnight Tools also stopped in **March 2026**.

- All three expect the **pre-V2 desktop layout**:
  `resources/app.asar.unpacked/src-electron/dist/preload/index.js`.
  BetterFluxer's own README says: *"If Fluxer only has packed app.asar without app.asar.unpacked preload, injection is not supported."*
- Current Fluxer V2 builds have **no `src-electron/` tree**; the preload is `dist/preload/index.cjs`, packed inside `app.asar`. Package-managed installs (including `/opt/fluxer-bin` on Linux) also do not live at the hard-coded `~/.fluxer/fluxer` path, so BetterFluxer would not find them either.

So no, BetterFluxer is effectively dormant/broken for current Fluxer. Hence this loader.

Its **plugin store** has a second, independent problem: the store is only a
button inside the injected settings tab, and its default index
`https://raw.githubusercontent.com/RoxyBoxxy/BetterFluxer/refs/heads/main/plugins.json`
returns **404**. A store is just a static JSON file fetched at runtime, so
"hosted on GitHub" is necessary but not sufficient — the file must exist and the
client must know its URL. The store built into this mod works the same way, but
ships a local index and lets you point it at any working URL.

---

## How this works

```
bin/fluxlink.js
  └─ restarts Fluxer with --remote-debugging-port=9222 --remote-allow-origins='*'
  └─ src/loader.mjs connects over CDP and injects src/plugin/fluxer-bb.js
        into the renderer's MAIN WORLD (Runtime.evaluate +
        Page.addScriptToEvaluateOnNewDocument, so reloads stay patched)
```

**Why CDP instead of editing `app.asar`:**

1. `app.asar` is root-owned — repacking needs `sudo` on every Fluxer update.
2. Electron's `contextIsolation` means a preload script gets its **own** `navigator`, so patching `navigator.mediaDevices` from a preload has no effect on the app. CDP injection touches the same objects the app itself uses.
3. Nothing on disk inside the Fluxer install is modified, so Fluxer's updater cannot break it and uninstalling is "stop the loader".

### Three modes

All are selected in the panel. The first two take effect on the next share; mirror
starts immediately from the panel button.

**1. Broadcast Box (default) — native share, uncapped quality**

Fluxer captures through `navigator.mediaDevices.getDisplayMedia()`. The plugin wraps it:

```
getDisplayMedia(args)
   ├─ rewrite constraints: ignore Fluxer's width/height hints, apply maxHeight cap,
   │                       set frameRate to <fps>
   ├─ real MediaStream = real capture (full res / fps)
   │     └─► POST /api/whip  (Bearer <derived key>)  ─►  Broadcast Box   [real quality]
   └─ placeholder MediaStream (small canvas, muted copy + "LIVE • BROADCAST BOX")
         └─► Fluxer publishes the placeholder to LiveKit as the screen-share track
```

Why a placeholder: LiveKit's encoder is capped by Fluxer's own plan presets
(free = 1280×720@30, `MAX_SCREEN_SHARE_BITRATE = 9 Mbps`). The cheap canvas copy
costs almost nothing and keeps Fluxer's tile, preview and "someone is sharing"
state working, while the real pixels go to Broadcast Box at the configured
resolution, fps and bitrate.

Viewers running this plugin get the real stream: for every
`[data-source="screen_share"]` tile the plugin reads the participant identity from
the React fiber, derives the Broadcast Box key, checks `/api/status`, and if live
WHEP-subscribes **video only** and swaps the `<video>`'s `srcObject`. Audio keeps
flowing through Fluxer/LiveKit, so unmodded viewers still hear you.

- Stream key = `fluxer-` + LiveKit identity (`user_<userId>_<connectionId>`), sanitised.
  It is derived on both sides, so **no link and no signalling are needed** — you just
  press Share screen.
- The plugin also swaps your *own* tile to the real capture so your preview is not
  the low-fps placeholder.

**2. Uncapped LiveKit — no Broadcast Box, no viewer mod**

Returns the real stream to Fluxer and raises the sender caps by patching
`RTCRtpSender.prototype.setParameters` for tracked screen tracks
(`maxBitrate`, `maxFramerate`, `degradationPreference: maintain-resolution`).
Everyone on stock Fluxer sees a normal, higher-quality share; nothing talks to
Broadcast Box. Useful when you cannot ask viewers to install anything.

**3. Mirror an existing Broadcast Box stream**

Use this when OBS (or another encoder) is already publishing a scene to your
Broadcast Box instance. In the panel, paste either the stream key or the full
WHIP/watch URL into **Mirror an existing Broadcast Box stream**, then press
**Mirror stream**.

```
OBS ──WHIP──► Broadcast Box
                   │
                   └─ WHEP (video + audio) ──► plugin mirror
                                                  └─► Fluxer screen-share track ──► LiveKit ──► all viewers
```

The plugin subscribes to the existing broadcast first, then calls Fluxer's own
`setScreenShareEnabled()` with the WHEP receiver stream as the capture source.
That means the normal Go Live state, tile, screen-share audio and native controls
work, and stock viewers see the mirrored feed through LiveKit. The plugin does
**not** publish back to Broadcast Box, so there is no feedback loop.

Other plugin users also watch a mirrored share through LiveKit. The normal
direct-Broadcast-Box tile swap only applies to regular BB publishing, because
that path derives a stream key from the broadcaster's Fluxer identity; an
arbitrary OBS key cannot be derived the same way. The mirror still bypasses
Fluxer's capture presets and gets the same sender-cap lift, so it is not tied to
the premium picker.

Notes:

- The mirror subscription accepts whatever codec Broadcast Box is already
  forwarding; the panel codec setting only affects the publish path.
- Both audio and video are mirrored when OBS publishes audio. If you leave your
  microphone unmuted, viewers hear both the OBS mix and your mic.
- A remirror decodes the Broadcast Box feed and re-encodes it for LiveKit, so it
  costs more CPU/GPU than a direct screen capture.
- The button uses Fluxer's internal `_mediaEngineFacade.setScreenShareEnabled`.
  If a future Fluxer build removes that API, the panel reports an error instead
  of silently opening the source picker.

### Broadcast Box protocol (verified against `d4d186a`, 4 Mar 2026)

| Step | Endpoint | Result |
|---|---|---|
| Publish | `POST /api/whip`, `Authorization: Bearer <streamKey>`, `Content-Type: application/sdp` | `201` + `Location: /api/whip/<id>` + answer SDP |
| Trickle ICE | `PATCH /api/whip/<id>` | needs `Content-Type: application/trickle-ice-sdpfrag` — **not used**, we wait for ICE gathering to complete |
| Stop | `DELETE /api/whip/<id>` | closes the session |
| Watch | `POST /api/whep`, `Authorization: Bearer <streamKey>` | answer SDP, `ontrack` → `<video>` |
| Status | `GET /api/status?key=<key>` | `200` when live, **`404 "No active stream found"`** when offline |
| CORS | all `/api/*` | `access-control-allow-origin: *` — works from the Fluxer page origin without a proxy ✅ |

### Codec, GPU encoding and resolution

The publisher pins **H264** — exactly one `packetization-mode=1` payload
(`RTCRtpTransceiver.setCodecPreferences`) — and tunes the sender *after* negotiation.
`Video codec` in the panel switches between `h264`, `vp9` and `auto`.

**Why H264 and not VP9.** On the AMD RDNA2 test system, `vainfo` shows VP9 and AV1
have no encode entrypoint at all (`VAEntrypointVLD` only), so they always run on the CPU:
measured **14–19 fps** at 1080p with `libvpx`. That was the stutter. H264 *does* have
hardware encode (`VAEntrypointEncSlice`) and, with the fixes below, reaches
**59 fps at 1920×1080** on the GPU.

Three separate things had to be understood to get there:

1. **Mesa/radeonsi VAAPI H264 keyframes** (Chromium issue `574768145`) — Chromium's
   `VaapiVideoEncodeAccelerator` submits the packed slice header *before* the packed
   SPS/PPS, and Mesa writes packed headers in submission order, so every key frame
   comes out as `IDR SPS PPS` instead of `SPS PPS IDR`. Receivers then discard every
   key frame: `framesReceived` climbs, `framesDecoded` stays 0 forever. OBS is
   unaffected because it builds its own NAL ordering, which is why "VAAPI works fine
   in OBS" is not contradictory.
   **Fix:** a sender *encoded transform* (`RTCRtpScriptTransform` on a blob worker)
   that moves NAL 7/8 in front of the slice, exactly as the Chromium issue suggests.
   Set `h264NalFix: false` in `localStorage["fluxerBB.config.v2"]` to disable it.
2. **Packetization mode** — Broadcast Box's multi-codec binding is map-ordered, so
   offering every H264 profile can negotiate a `packetization-mode=0` answer, which
   cannot carry FU-A packets at high bitrate. The mod offers a single `pm=1` payload,
   and the WHEP viewer pins the same one.
3. **`setParameters()` before the SDP exchange** leaves the encoder unable to emit
   keyframes (`framesDecoded = 0`). It must run after `setRemoteDescription`.

Measured on an AMD RDNA2 test system (Mesa 26.2.4, Chrome 152):

| Path | Encoder | Result |
|---|---|---|
| direct Chrome→Chrome loopback | `VaapiVideoEncodeAccelerator` | **199/200 decoded, 0 dropped**, 1920×1080 |
| through Broadcast Box | `VaapiVideoEncodeAccelerator` @ **59 fps** | **443/445 decoded, 0 dropped**, 1920×1080 @ 47 fps |
| VP9 (previous default) | `libvpx` (CPU) | 14–19 fps @1080p |

If H264 ever misbehaves on another machine, switch `Video codec` to `vp9`; it is
software-only but decodes everywhere. Both ends should use the same codec.

**Resolution.** Fluxer gates its resolution presets behind the premium plan (clicking
one opens the subscribe page). The mod ignores Fluxer's `width`/`height` hints
completely, so the paywall has no effect on what gets captured, and the panel's
**Capture resolution** selector (`Native` / `2160p` / `1440p` / `1080p` / `720p`)
applies its own `height: {max: …}` cap — a height-only cap keeps the monitor's
aspect ratio.

### Server bug this mod works around

Broadcast Box `d4d186a` creates an **audio** track object for every WHEP session even
when the viewer's offer has no audio m-line. That object is never bound, so the first
publisher audio packet hits a nil writer and **segfaults the server**
(`TrackMultiCodec.WriteRTP` ← `WHEPSession.SendAudioPacket` ← `WHIPSession.audioWriter`).
A video-only WHEP offer therefore crashes Broadcast Box. The plugin always offers an
audio m-line (`recvonly`) even though it only consumes the video. Re-check this after
upgrading Broadcast Box.

---

## Run it

Requires **Node 22 or newer**. Nothing is installed inside Fluxer.

Download the latest release zip from
<https://github.com/coffeecode3d/fluxlink/releases>, or clone the repo:

```bash
git clone https://github.com/coffeecode3d/fluxlink.git
cd fluxlink
node bin/fluxlink.js            # asks before restarting Fluxer; then injects
node bin/fluxlink.js --yes      # no prompt
node bin/fluxlink.js --attach   # don't launch anything; inject into a running (already-flagged) Fluxer
node bin/fluxlink.js --check    # list CDP targets and exit
```

On Windows use `node bin\fluxlink.js` (or `npm start` after `npm install`).

```bash
node src/loader.mjs --check      # list CDP targets and exit
node src/loader.mjs --force      # tear down and re-inject after editing the plugin
node src/verify.mjs              # self-check checklist (skips BB checks without a host)
node src/verify.mjs --host https://bb.example.com
node src/verify.mjs --host https://bb.example.com --selftest  # + WHIP → WHEP round-trip
node src/verify.mjs --live       # dump screen-share tiles while a share is running
node src/verify.mjs --shot=./panel.png   # screenshot the panel
```

Fluxer must be (re)started with the debugging flag — Electron's single-instance lock
means the flag cannot be added to an already-running app. The loader keeps running to
re-inject if the renderer navigates or the app restarts; `Ctrl-C` detaches and leaves
the plugin in place (until Fluxer restarts).

For a second machine, follow [TESTING.md](TESTING.md).

### Launcher behavior

The bundled launcher starts Fluxer with CDP and then runs the loader. It
autodetects Fluxer in common install locations on Windows, Linux and macOS. Set
`FLUXER_BIN` if your install is somewhere else. If the loader fails, Fluxer still
launches normally — the launcher only adds flags and starts the loader.

Use `node bin/fluxlink.js --print-bin` to see which Fluxer executable it found.
The loader logs to the terminal; keep that window open while testing. Add
`--verbose` to see plugin console messages.

### Using it

A **broadcast icon button** sits in the voice-call controls, immediately to the
right of **Share your screen**. It reuses Fluxer's own button classes, so
theming, spacing and hover states come for free, and a red dot marks an active
publish. Outside a call (or if Fluxer changes its control bar) the same panel is
reachable from the floating **BB** button in the bottom-right.

The panel has:

- **Mode** — `Broadcast Box` (native uncapped share) or `Uncapped LiveKit` (no BB)
- **fps** / **Mbps** / **Host** — quality sent to Broadcast Box
- **Video codec** — `H264` (GPU, default), `VP9` (software fallback) or `auto`
- **Capture resolution** — `Native`, `2160p`, `1440p`, `1080p`, `720p`; bypasses
  Fluxer's premium-gated preset picker entirely
- **Mirror an existing Broadcast Box stream** — paste an OBS/WHIP key or URL,
  then press **Mirror stream** / **Stop mirror**
- Status line: your derived stream key, whether you are publishing or mirroring,
  and active swaps

The **Host** field starts empty by design. Paste your own Broadcast Box URL and
it saves automatically (after a short pause, or immediately on blur); until
then, shares stay on LiveKit and the panel says so.

Panel settings persist through Fluxer's scoped desktop store
(`window.electron.desktopStorage`, scope `fluxer-bb`). This build exposes no
`localStorage`/`sessionStorage`/IndexedDB on `fluxer-app://`, so the plugin falls back
to the preload store and still works if that API ever disappears (it just won't
remember changes across reloads).

Then in Fluxer: join a voice channel → **Share screen** → pick a window/screen.
There is nothing else to click — the key is derived from your identity.

The store is also a real page in Fluxer's own settings: **Settings → Developer →
Plugins** (the entry is injected at runtime). It keeps Fluxer's native header and
sidebar, and adds index selection, the installed list with per-plugin switches,
and an Available list with install buttons. The Broadcast Box panel stays a
separate surface; `Ctrl+Shift+B` toggles it as well.

### Plugin store

The panel has a **Plugins** section: installed plugins, each with
Enable/Disable and Remove, plus a **Store** button. The full experience lives in
**Settings → Developer → Plugins**, which is a real settings page rather than a
shortcut to the panel. The renderer never writes files — installs go through the
loader's local HTTP API on `127.0.0.1:9224` (`--api-port` /
`FLUXER_BB_API_PORT`), which owns `~/.config/fluxer-bb/plugins/<id>/` and
`plugins.json`.

The store index is plain JSON, exactly like BetterFluxer's — a static file on
GitHub raw, a gist, or any HTTPS host:

```json
{
  "plugins": [
    { "id": "my-plugin", "manifest": "https://example.com/my-plugin/manifest.json" }
  ]
}
```

`manifest` is resolved at install time and may instead inline the code:
`{ "id": "...", "code": "define({...})" }`. A manifest is
`{ "name": "...", "version": "...", "description": "...", "main": "plugin.js" }`
with `main` relative to the manifest URL. In the settings page (or the panel's
store view) set the index to `builtin`, an HTTPS URL, or a GitHub shorthand such
as `owner/repo` (which resolves to
`https://raw.githubusercontent.com/owner/repo/HEAD/plugins/index.json`). Normal
GitHub repo URLs and `/blob/<branch>/<path>` links are also accepted. The choice
is persisted in the panel config.

Bundled examples in `<repo>/plugins/`:

| id | what it does |
| --- | --- |
| `stats-overlay` | live encoder / resolution / fps / Mbps while publishing |
| `hotkey-panel` | `Ctrl+Shift+B` toggles the panel |

Plugin contract — the file is evaluated with `define` and `ctx` in scope:

```js
define({
  id: "example",
  start(ctx) {
    // ctx.bb        = the __fluxerBB API (state, debugAsync, openPanel, …)
    // ctx.state()   = shortcut for ctx.bb.state()
    // ctx.kv.get/set(key[, value]) = desktop-store-backed per-plugin storage
    // ctx.setInterval / ctx.setTimeout / ctx.onDispose = auto-cleaned on stop
  },
  stop() {},
});
```

Plugins are loaded as `blob:` scripts rather than `new Function()`, because
Fluxer's CSP has no `unsafe-eval` (blob scripts are allowed). They run with full
access to the window, so only install code you trust — the store says so, and the
loader only fetches `https://` URLs (plus `http://127.0.0.1`).

To publish your own index, commit it to a repo and use the raw URL, e.g.
`https://raw.githubusercontent.com/<user>/<repo>/main/plugins/index.json`, or
just `user/repo` if it lives at `plugins/index.json` on the default branch.

### Debug handles (from devtools console)

```js
__fluxerBB.state()        // version, mode, key, publishing, mirror, tiles, swaps, lastError
__fluxerBB.startMirror("streamKeyOrUrl")
__fluxerBB.stopMirror()
__fluxerBB.mirror         // live mirror state
__fluxerBB.debug()        // publisher + swap summary
__fluxerBB.debugAsync()   // + WHEP peer-connection state and per-swap RTP stats
__fluxerBB.tiles()        // identity / isLocal / derived key for each share tile
__fluxerBB.findLocalIdentity()
__fluxerBB.keyForIdentity(identity)
__fluxerBB.scan()         // force a viewer scan
__fluxerBB.openPanel()
__fluxerBB.openSettings()   // embedded Settings → Plugins page
__fluxerBB.closePanel() / __fluxerBB.togglePanel()
__fluxerBB.plugins.refresh() / .list() / .running() / .api() / .error()
__fluxerBB.publish(stream, key) / __fluxerBB.stopPublish()   // used by --selftest
__fluxerBB.testCapture(stream)   // run the Broadcast Box branch without a picker
__fluxerBB.stop()         // full teardown
```

---

## Known limitations

- One BB stream per sharing user; the key is the LiveKit identity, so reconnecting to
  voice produces a new key (viewers re-derive it automatically).
- **Viewers with the plugin** get the full-quality Broadcast Box stream in `bb` mode.
  **Unmodded viewers** are supposed to see the low-fps placeholder through LiveKit;
  the preview/tile handoff is still being debugged on current Fluxer. If a stock
  viewer sees no tile or a blank preview, reproduce the same share in `uncapped` or
  `mirror` mode for comparison. This is the main open issue.
- **Mirror mode** publishes through LiveKit for everyone. Plugin viewers do not get
  the direct-BB tile swap in that mode because the OBS key is not derived from the
  broadcaster's Fluxer identity.
- Only **video** is offloaded to Broadcast Box in `bb` mode. Audio stays on LiveKit
  (~64–128 kbps), so unmodded viewers still hear you.
- Fluxer's own resolution selector remains paywalled — use the panel's **Capture
  resolution** instead. The mod never lets Fluxer's preset reach the capture.
- Hardware H264 relies on the NAL-reorder transform. If a future Fluxer/Chromium
  build already emits correct keyframes the transform is a no-op; if H264 still
  fails, switch the codec to VP9 (software, but universal).
- You must be **in the voice channel** to advertise the share: Fluxer's `self_stream`
  state drives the tile.
- `uncapped` mode is best-effort by design: LiveKit may still throttle a sender.
- A reverse proxy can buffer Broadcast Box's `/api/sse`. This mod does not use SSE, but
  the stock Broadcast Box UI may hang on video controls until the proxy is configured
  to disable buffering.
- Anyone with a stream key can publish or watch on a Broadcast Box instance whose
  `STREAM_PROFILE_POLICY` is too permissive (`ANYONE_WITH_RESERVED`). Use reserved
  keys and restrict access.

## Uninstall

```bash
pkill -f "src/[l]oader.mjs"   # stop the loader
# then restart Fluxer normally (no flags) to drop the injected plugin entirely
```

Nothing inside `/opt/fluxer-bin` or `~/.config/fluxer` is modified — no `app.asar`
repacking, so Fluxer updates cannot be broken by this and there is nothing to unpatch.

## If the plugin disappears

The launcher keeps `src/loader.mjs` running in the foreground: it stays attached
across renderer navigations and re-injects when a new Fluxer window appears. Keep
the terminal open while testing; `Ctrl-C` detaches but leaves the plugin injected
until Fluxer restarts.

If the button is still missing, rerun the launcher with `--verbose` and check that
Fluxer was started with the required CDP flag (use the bundled launcher) rather
than directly from its desktop binary.

## Security notes

See [SECURITY.md](SECURITY.md) for the local attack surface and private reporting.

- `--remote-debugging-port=9222` binds localhost only, but any local process could then
  control Fluxer. Don't leave the loader running on a shared machine. Set
  `FLUXER_DEBUG_PORT` to change the port.
- The plugin talks only to the Broadcast Box host you configure. It reads no credentials
  and never touches your Fluxer token.
- The plugin store API (`127.0.0.1:9224`) is unauthenticated and can write plugin code
  that runs inside Fluxer. Any local process can use it, just like the CDP port. Plugins
  from a remote index run with full page access — only install indexes/code you trust.
  Set `FLUXER_BB_API_PORT` to move it.
- A Broadcast Box instance with `ANYONE_WITH_RESERVED` accepts **any** stream key from
  anyone on the internet. Use reserved keys, a publish secret, or network restrictions.

## Layout

```
bin/fluxlink.js               cross-platform launcher (restart Fluxer with CDP + run loader)
bin/fluxer-bb                 compatibility alias for the old launcher path
src/loader.mjs                CDP injector, zero dependencies
src/store.mjs                 local plugin-store HTTP API (127.0.0.1:9224)
plugins/                      built-in store index + example plugins
src/verify.mjs                self-check checklist (+ --selftest, --live, --shot)
src/plugin/fluxer-bb.js       the plugin (capture hook, WHIP publisher, WHEP viewer, UI)
```

## Privacy

This project collects no telemetry and ships no default Broadcast Box host. Panel
settings and installed plugins are stored locally in the user's config directory
(`~/.config/fluxer-bb/` by default, `$XDG_CONFIG_HOME/fluxer-bb/`, or the
platform-equivalent home path on Windows). The plugin contacts only the Broadcast
Box URL you enter, and the loader contacts only plugin-index URLs you choose. Logs
stay on your machine.

License: MIT (this mod). Fluxer itself is AGPL-3.0 — this project injects at runtime
and ships none of its code. Broadcast Box is MIT.
