# Two-device test checklist

This is the quickest way to validate a Fluxlink test build with a second machine.

## What you need

- Two devices with the Fluxer desktop client installed.
- **Node 22 or newer** on both devices.
- The same Fluxlink checkout on both devices.
- Both clients in the **same Fluxer voice channel**.
- A Broadcast Box instance you control (for `bb` and `mirror` tests).
- Optionally, a third Fluxer client **without** the plugin, to test stock viewers.

## 1. Start Fluxlink on both devices

```bash
git clone https://github.com/coffeecode3d/fluxlink.git
cd fluxlink
node bin/fluxlink.js --install
```

Windows:

```powershell
git clone https://github.com/coffeecode3d/fluxlink.git
cd fluxlink
node bin\fluxlink.js --install
```

After installing, close Fluxer and open it from the normal Fluxer icon. The
launcher runs in the background; no terminal needs to stay open. If you prefer a
terminal, `node bin/fluxlink.js` still works. Confirm:

- the broadcast button appears next to **Share your screen** in the call controls;
- the floating **BB** button exists outside a call;
- the panel reports version `0.8.1` or newer;
- **Settings → Developer → Plugins** exists.

Set your Broadcast Box host in the panel on both devices. Do not use a host you do
not trust, and do not paste a stream key into a public issue.

## 2. Test `bb` mode (Broadcast Box)

On the broadcaster:

1. Join the voice channel.
2. Panel → **Mode** → `Broadcast Box`.
3. Choose `H264`, `1080p`, `60 fps`.
4. Press **Share screen** and pick a window/screen.

Expected:

- the broadcaster’s panel shows **publishing** and a derived stream key;
- a second Fluxlink client sees the tile and swaps it to the direct Broadcast Box
  stream;
- the second client’s panel reports active swaps and a decoded resolution.

Record these on the viewer:

```js
__fluxerBB.state()
__fluxerBB.remoteStreams()   // LiveKit screen publications the viewer can see
__fluxerBB.heal()            // force the missed self_stream state repair
__fluxerBB.tiles()           // native screen-share tiles after the repair
__fluxerBB.debugAsync()
```

If no tile appears on a plugin viewer, `__fluxerBB.remoteStreams()` should still list
the broadcaster. `__fluxerBB.heal()` rebuilds the missing gateway `self_stream` state
from that publication; `tiles()` should then return one entry and the panel should
show `LiveKit stream(s) detected (repaired N)`. Report both outputs.

Known open issue: a **stock Fluxer client** may show the screen-share tile but a
blank preview, or no tile at all. If that happens, note whether the tile exists and
whether the placeholder is blank. Then repeat the same share in `uncapped` mode so
we can tell whether the problem is the placeholder or the Broadcast Box path.

## 3. Test `uncapped` mode

1. On the broadcaster, set **Mode** → `Uncapped LiveKit`.
2. Stop and start the share.
3. Confirm both plugin and stock viewers see and hear the share.

This path does not use Broadcast Box, so it is the control case for LiveKit
visibility.

## 4. Test mirror mode

This requires OBS (or another encoder) already publishing to your Broadcast Box
instance.

1. Start the OBS stream to Broadcast Box.
2. Copy the stream key, or the full WHIP/watch URL.
3. In the broadcaster’s panel, paste it under **Mirror an existing Broadcast Box
   stream** and press **Mirror stream**.
4. Confirm the normal Fluxer Go Live state and tile appear.
5. Confirm the viewer sees the OBS scene.
6. Press **Stop mirror** and confirm the tile and WHEP session go away.

Mirror mode publishes through LiveKit for all viewers, including viewers with the
plugin. The direct Broadcast Box tile swap only applies to normal `bb` publishing.

## 5. Test stop and recovery

- Stop the share from Fluxer’s native control bar.
- Start a second share without reloading the plugin.
- Quit and relaunch Fluxer from the launcher.
- Confirm the plugin re-injects and the panel settings persist.

## 6. Report results

Open an issue at <https://github.com/coffeecode3d/fluxlink/issues> with:

- Fluxer version, OS, and GPU;
- mode tested (`bb`, `uncapped`, or `mirror`);
- viewer type (plugin or stock);
- what you expected and what happened;
- `__fluxerBB.state()` and `__fluxerBB.debugAsync()` output, with keys and personal
  information redacted;
- the launcher/loader terminal output.

Never post stream keys, tokens, private Broadcast Box URLs, or personal information.
