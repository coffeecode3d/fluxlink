/*
 * Stream stats overlay — a FluxerBB example plugin.
 *
 * Contract: the file is evaluated with `define` and `ctx` in scope. Call
 * define({ id, name, version, start(ctx), stop() }). Timers and listeners
 * registered through ctx are torn down automatically when the plugin stops.
 */
define({
	id: "stats-overlay",
	name: "Stream stats overlay",
	version: "1.0.0",
	start(ctx) {
		const box = document.createElement("div");
		box.id = "fluxer-bb-stats-overlay";
		box.style.cssText = [
			"position:fixed",
			"left:14px",
			"bottom:14px",
			"z-index:2147483000",
			"padding:8px 10px",
			"border-radius:10px",
			"background:rgba(10,14,20,.88)",
			"border:1px solid rgba(255,255,255,.14)",
			"box-shadow:0 6px 24px rgba(0,0,0,.35)",
			"color:#dbe5f2",
			"font:11px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif",
			"white-space:pre",
			"pointer-events:none",
			"display:none",
			"letter-spacing:.01em",
		].join(";");
		(document.body || document.documentElement).appendChild(box);
		ctx.onDispose(() => box.remove());

		let lastBytes = 0;
		let lastTime = 0;
		let busy = false;

		const tick = async () => {
			if (busy) return;
			const state = ctx.state();
			if (!state.publishing) {
				box.style.display = "none";
				lastBytes = 0;
				lastTime = 0;
				return;
			}
			busy = true;
			try {
				const debug = await ctx.bb.debugAsync();
				const p = (debug.publisherStats || [])[0];
				if (!p) {
					box.textContent = "publishing…";
					box.style.display = "block";
					return;
				}
				const now = performance.now();
				let mbps = 0;
				if (lastTime && p.bytes >= lastBytes) {
					mbps = ((p.bytes - lastBytes) * 8) / ((now - lastTime) / 1000) / 1e6;
				}
				lastBytes = p.bytes;
				lastTime = now;

				const encoder = String(p.encoder || "?")
					.replace(/VideoEncodeAccelerator|VideoEncoder/g, "")
					.trim();
				const head = `${encoder || "?"} · ${p.width || "?"}×${p.height || "?"} @ ${p.fps || "?"} fps`;
				const rate = `${mbps.toFixed(1)} / ${((p.targetBitrate || 0) / 1e6).toFixed(1)} Mbps`;
				const limit = p.reason && p.reason !== "none" ? ` · ${p.reason}` : "";
				box.textContent = `${head}\n${rate}${limit}`;
				box.style.display = "block";
			} catch (_) {
				box.style.display = "none";
			} finally {
				busy = false;
			}
		};

		ctx.setInterval(tick, 1500);
	},
	stop() {},
});
