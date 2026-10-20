/*
 * Panel hotkey — a FluxerBB example plugin.
 *
 * Ctrl+Shift+B toggles the FluxerBB panel. The listener is registered in the
 * capture phase so Fluxer's own handlers don't swallow the combination.
 */
define({
	id: "hotkey-panel",
	name: "Panel hotkey",
	version: "1.0.0",
	start(ctx) {
		const onKey = (ev) => {
			if (!ev.ctrlKey || !ev.shiftKey || ev.altKey || ev.metaKey) return;
			if (String(ev.key).toLowerCase() !== "b") return;
			ev.preventDefault();
			ev.stopPropagation();
			try {
				ctx.bb.togglePanel();
			} catch (_) {}
		};
		window.addEventListener("keydown", onKey, true);
		ctx.onDispose(() => window.removeEventListener("keydown", onKey, true));
	},
	stop() {},
});
