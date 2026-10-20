/* Fluxlink — one-command installer
 * SPDX-License-Identifier: MIT
 *
 * Makes Fluxlink the thing your normal Fluxer shortcut launches, so the
 * plugin is injected without keeping a terminal open. Nothing inside the
 * Fluxer installation is modified: we install a small launcher wrapper and
 * user-level desktop/shortcut entries that point at it.
 *
 *   node bin/fluxlink.js --install
 *   node bin/fluxlink.js --install --autostart
 *   node bin/fluxlink.js --uninstall
 *   node bin/fluxlink.js --status
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync, spawn} from "node:child_process";
import {ensureStateDir, lockPath, readLock, stateDir} from "./paths.mjs";

const MARKER = "X-Fluxlink=true";
const MANIFEST = "install.json";

function log(...a) {
	console.log("[install]", ...a);
}

function readManifest() {
	try {
		return JSON.parse(fs.readFileSync(path.join(stateDir(), MANIFEST), "utf8")) || {};
	} catch (_) {
		return {};
	}
}

function writeManifest(data) {
	ensureStateDir();
	fs.writeFileSync(path.join(stateDir(), MANIFEST), JSON.stringify(data, null, 2));
}

function ensureDir(dir) {
	fs.mkdirSync(dir, {recursive: true});
}

function exists(file) {
	try {
		fs.statSync(file);
		return true;
	} catch (_) {
		return false;
	}
}

function safeName(value) {
	return Buffer.from(value).toString("base64url").slice(0, 120);
}

function backupFile(manifest, file) {
	if (!exists(file)) return;
	if (manifest.backups[file]) return;
	const dir = path.join(stateDir(), "backup");
	ensureDir(dir);
	const dest = path.join(dir, safeName(file));
	fs.copyFileSync(file, dest);
	manifest.backups[file] = dest;
}

function markCreated(manifest, file) {
	if (!manifest.created.includes(file)) manifest.created.push(file);
}

function stopRunningLoaders() {
	let names = [];
	try {
		names = fs.readdirSync(stateDir());
	} catch (_) {
		return;
	}
	for (const name of names) {
		if (!/^loader-\d+\.pid$/.test(name)) continue;
		const file = path.join(stateDir(), name);
		const lock = readLock(file);
		if (lock && lock.pid) {
			try {
				process.kill(lock.pid, "SIGTERM");
				log(`stopped loader (pid ${lock.pid})`);
			} catch (_) {}
		}
		try {
			fs.unlinkSync(file);
		} catch (_) {}
	}
}

function writeManaged(manifest, file, content, mode) {
	ensureDir(path.dirname(file));
	backupFile(manifest, file);
	fs.writeFileSync(file, content);
	if (mode) {
		try {
			fs.chmodSync(file, mode);
		} catch (_) {}
	}
	markCreated(manifest, file);
}

function quoteExec(value) {
	const text = String(value);
	if (!text) return '""';
	if (/[\s"']/.test(text)) return '"' + text.replace(/"/g, '\\"') + '"';
	return text;
}

function splitExec(value) {
	const tokens = [];
	let current = "";
	let quote = null;
	for (const ch of String(value || "")) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

function looksLikeExecutable(token) {
	const value = String(token || "");
	if (!value) return false;
	if (/fluxer/i.test(value)) return true;
	if (value.startsWith("/") || value.startsWith("~")) return true;
	if (/\.(exe|app|sh|bin)$/i.test(value)) return true;
	return false;
}

function execSuffix(execValue) {
	const tokens = splitExec(execValue);
	if (!tokens.length) return "";
	let index = tokens.findIndex(looksLikeExecutable);
	if (index < 0) index = 0;
	return tokens.slice(index + 1).join(" ");
}

function rewriteDesktop(content, wrapper) {
	const lines = String(content).split(/\r?\n/);
	const out = [];
	let wroteMarker = false;
	let inEntrySection = false;
	for (const line of lines) {
		if (/^\[Desktop Entry\]\s*$/.test(line)) {
			inEntrySection = true;
			out.push(line);
			if (!wroteMarker) {
				out.push(MARKER);
				wroteMarker = true;
			}
			continue;
		}
		if (/^\[/.test(line)) inEntrySection = false;
		if (/^X-Fluxlink=/.test(line)) continue;
		const match = /^(Exec|TryExec)=(.*)$/.exec(line);
		if (match) {
			if (match[1] === "TryExec") out.push(`TryExec=${quoteExec(wrapper)}`);
			else {
				const suffix = execSuffix(match[2]);
				out.push(`Exec=${quoteExec(wrapper)}${suffix ? " " + suffix : ""}`);
			}
			continue;
		}
		out.push(line);
	}
	if (!wroteMarker && inEntrySection) out.push(MARKER);
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function resolveMaybe(file) {
	try {
		return fs.realpathSync(file);
	} catch (_) {
		return path.resolve(file);
	}
}

function firstExecToken(content) {
	const match = /^Exec=(.*)$/m.exec(String(content || ""));
	if (!match) return "";
	const tokens = splitExec(match[1]);
	return tokens.find(looksLikeExecutable) || tokens[0] || "";
}

function sameExecutable(content, bin) {
	if (!bin) return /fluxer/i.test(content);
	const first = firstExecToken(content);
	if (!first) return false;
	if (path.basename(first) === path.basename(bin)) return true;
	return resolveMaybe(first) === resolveMaybe(bin);
}

function collectDesktopSources(bin) {
	const home = os.homedir();
	const dirs = [
		path.join(home, ".local", "share", "applications"),
		"/usr/local/share/applications",
		"/usr/share/applications",
	];
	const files = [];
	for (const dir of dirs) {
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch (_) {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".desktop")) continue;
			const file = path.join(dir, name);
			let content = "";
			try {
				content = fs.readFileSync(file, "utf8");
			} catch (_) {
				continue;
			}
			if (!/fluxer/i.test(name) && !/fluxer/i.test(content)) continue;
			if (!/^Exec=/m.test(content)) continue;
			// Our own previously installed entries have an Exec that points at
			// the wrapper, so accept them by marker instead of by executable.
			if (!content.includes(MARKER) && bin && !sameExecutable(content, bin)) continue;
			files.push({file, name, content});
		}
	}
	return files;
}

/* ------------------------------------------------------------------ linux */

function linuxWrapperScript(root) {
	const log = path.join(stateDir(), "launcher.log");
	return `#!/bin/sh
# Generated by Fluxlink. Re-run: node ${quoteExec(path.join(root, "bin", "fluxlink.js"))} --install
LOG=${quoteExec(log)}
exec ${quoteExec(process.execPath)} ${quoteExec(path.join(root, "bin", "fluxlink.js"))} --daemon --yes "$@" >>"$LOG" 2>&1
`;
}

function linuxAutostartEntry(wrapper) {
	return `[Desktop Entry]
Type=Application
Version=1.0
Name=Fluxlink (Fluxer)
Comment=Start Fluxer through Fluxlink
Exec=${quoteExec(wrapper)}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
${MARKER}
`;
}

function hideAutostartEntries(manifest, bin) {
	const dir = path.join(os.homedir(), ".config", "autostart");
	let names = [];
	try {
		names = fs.readdirSync(dir);
	} catch (_) {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".desktop")) continue;
		if (name === "fluxlink.desktop") continue;
		const file = path.join(dir, name);
		let content = "";
		try {
			content = fs.readFileSync(file, "utf8");
		} catch (_) {
			continue;
		}
		if (!/fluxer/i.test(name) && !/fluxer/i.test(content)) continue;
		if (/^Hidden=true/m.test(content)) continue;
		if (content.includes(MARKER)) continue;
		// Only hide the same install we are managing. A Fluxer Canary
		// autostart has a different executable and must stay untouched.
		if (bin && !sameExecutable(content, bin)) continue;
		backupFile(manifest, file);
		const next = content.replace(/^Hidden=.*$/m, "").replace(/\s*$/, "\n") + "Hidden=true\n";
		fs.writeFileSync(file, next);
		markCreated(manifest, file);
		log(`disabled duplicate Fluxer autostart: ${file}`);
	}
}

function installLinux({root, autostart, bin}) {
	const manifest = {
		version: 1,
		platform: process.platform,
		root,
		created: [],
		backups: {},
	};
	const wrapper = path.join(os.homedir(), ".local", "bin", "fluxlink-launch");
	writeManaged(manifest, wrapper, linuxWrapperScript(root), 0o755);
	log(`launcher wrapper: ${wrapper}`);
	if (bin) log(`target Fluxer: ${bin}`);

	const sources = collectDesktopSources(bin);
	const seen = new Set();
	let installed = 0;
	for (const source of sources) {
		const target = source.file.startsWith(path.join(os.homedir(), ".local"))
			? source.file
			: path.join(os.homedir(), ".local", "share", "applications", source.name);
		if (seen.has(target)) continue;
		seen.add(target);
		const rewritten = rewriteDesktop(source.content, wrapper);
		writeManaged(manifest, target, rewritten, 0o644);
		installed += 1;
		log(`desktop entry: ${target}`);
	}
	if (!installed) log("no Fluxer .desktop files found; you may need FLUXER_BIN or a desktop entry name hint");
	try {
		execFileSync("update-desktop-database", [path.join(os.homedir(), ".local", "share", "applications")], {
			stdio: "ignore",
			windowsHide: true,
		});
	} catch (_) {}

	const auto = path.join(os.homedir(), ".config", "autostart", "fluxlink.desktop");
	if (autostart) {
		writeManaged(manifest, auto, linuxAutostartEntry(wrapper), 0o644);
		hideAutostartEntries(manifest, bin);
		log(`autostart: ${auto}`);
	} else if (exists(auto)) {
		log(`autostart already present: ${auto}`);
	}

	writeManifest(manifest);
	return {wrapper, entries: installed, autostart};
}

/* ---------------------------------------------------------------- windows */

function windowsWrapperScript(root) {
	// VBScript string literals keep backslashes as-is. Do not pre-escape them
	// or a path like C:\Program Files becomes C:\\Program Files.
	const node = process.execPath;
	const script = path.join(root, "bin", "fluxlink.js");
	return `Option Explicit
Dim sh, q, node, script, extra, i
Set sh = CreateObject("WScript.Shell")
q = Chr(34)
node = ${JSON.stringify(node)}
script = ${JSON.stringify(script)}
extra = ""
For i = 0 To WScript.Arguments.Count - 1
  extra = extra & " " & q & WScript.Arguments(i) & q
Next
sh.Run q & node & q & " " & q & script & q & " --daemon --yes" & extra, 0, False
`;
}

function powershell(script) {
	return execFileSync(
		"powershell",
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
		{encoding: "utf8", windowsHide: true},
	);
}

function shortcutScript(target, argumentsValue, icon, workdir) {
	const esc = (value) => String(value).replace(/'/g, "''");
	return `$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${esc(target)}')
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '${esc(argumentsValue)}'
$sc.IconLocation = '${esc(icon)},0'
$sc.WorkingDirectory = '${esc(workdir)}'
$sc.Description = 'Launch Fluxer through Fluxlink'
$sc.Save()`;
}

function findFluxerExe(bin) {
	if (bin && /\.exe$/i.test(bin) && exists(bin)) return bin;
	const candidates = [];
	const local = process.env.LOCALAPPDATA;
	if (local) {
		candidates.push(path.join(local, "Programs", "Fluxer", "Fluxer.exe"));
		candidates.push(path.join(local, "Fluxer", "Fluxer.exe"));
	}
	if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, "Fluxer", "Fluxer.exe"));
	if (process.env["PROGRAMFILES(X86)"]) candidates.push(path.join(process.env["PROGRAMFILES(X86)"], "Fluxer", "Fluxer.exe"));
	for (const candidate of candidates) {
		if (exists(candidate)) return candidate;
	}
	return candidates[0] || "Fluxer.exe";
}

function listShortcuts(dir, depth = 0) {
	if (depth > 3) return [];
	let names = [];
	try {
		names = fs.readdirSync(dir, {withFileTypes: true});
	} catch (_) {
		return [];
	}
	const out = [];
	for (const entry of names) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listShortcuts(full, depth + 1));
		else if (entry.name.toLowerCase().endsWith(".lnk")) out.push(full);
	}
	return out;
}

function shortcutTarget(file) {
	try {
		const out = powershell(
			`$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('${file.replace(/'/g, "''")}'); Write-Output $sc.TargetPath`,
		);
		return out.trim();
	} catch (_) {
		return "";
	}
}

function installWindows({root, autostart, bin}) {
	const manifest = {
		version: 1,
		platform: process.platform,
		root,
		created: [],
		backups: {},
	};
	const dir = path.join(process.env.LOCALAPPDATA || stateDir(), "Fluxlink");
	const wrapper = path.join(dir, "launch.vbs");
	writeManaged(manifest, wrapper, windowsWrapperScript(root), 0o644);
	log(`launcher wrapper: ${wrapper}`);

	const fluxer = findFluxerExe(bin);
	const args = `//B "${wrapper}"`;
	const workdir = path.dirname(path.join(root, "bin", "fluxlink.js"));
	const startMenu = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs");
	let desktopDir = path.join(os.homedir(), "Desktop");
	try {
		const resolved = powershell("[Environment]::GetFolderPath('Desktop')").trim();
		if (resolved) desktopDir = resolved;
	} catch (_) {}
	const pinned = path.join(
		process.env.APPDATA || "",
		"Microsoft",
		"Internet Explorer",
		"Quick Launch",
		"User Pinned",
		"TaskBar",
	);

	const targets = new Set([path.join(startMenu, "Fluxer.lnk"), path.join(desktopDir, "Fluxer.lnk")]);
	for (const shortcut of [
		...listShortcuts(startMenu),
		...listShortcuts(desktopDir),
		...listShortcuts(pinned),
	]) {
		// Avoid a PowerShell round-trip for every unrelated Start Menu item.
		if (!/fluxer/i.test(shortcut)) continue;
		const target = shortcutTarget(shortcut);
		if (/Fluxer\.exe$/i.test(target)) targets.add(shortcut);
	}
	for (const target of targets) {
		backupFile(manifest, target);
		try {
			powershell(shortcutScript(target, args, fluxer, workdir));
			markCreated(manifest, target);
			log(`shortcut: ${target}`);
		} catch (err) {
			log(`could not write ${target}: ${err.message}`);
		}
	}

	const startup = path.join(startMenu, "Startup");
	if (autostart) {
		const startupLink = path.join(startup, "Fluxlink.lnk");
		backupFile(manifest, startupLink);
		powershell(shortcutScript(startupLink, args, fluxer, workdir));
		markCreated(manifest, startupLink);
		for (const shortcut of listShortcuts(startup)) {
			if (shortcut === startupLink) continue;
			if (/Fluxer\.exe$/i.test(shortcutTarget(shortcut))) {
				backupFile(manifest, shortcut);
				try {
					fs.unlinkSync(shortcut);
					markCreated(manifest, shortcut);
					log(`disabled duplicate Fluxer startup shortcut: ${shortcut}`);
				} catch (_) {}
			}
		}
	}

	writeManifest(manifest);
	return {wrapper, entries: targets.size, autostart};
}

/* ------------------------------------------------------------------ macos */

function installMac({root, autostart, bin}) {
	const manifest = {
		version: 1,
		platform: process.platform,
		root,
		created: [],
		backups: {},
	};
	const appDir = path.join(os.homedir(), "Applications", "Fluxlink.app");
	const macosDir = path.join(appDir, "Contents", "MacOS");
	const plist = path.join(appDir, "Contents", "Info.plist");
	const script = path.join(macosDir, "Fluxlink");
	ensureDir(macosDir);
	writeManaged(
		manifest,
		plist,
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Fluxlink</string>
  <key>CFBundleDisplayName</key><string>Fluxlink</string>
  <key>CFBundleIdentifier</key><string>dev.fluxlink.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>Fluxlink</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`,
		0o644,
	);
	writeManaged(
		manifest,
		script,
		`#!/bin/sh
# Generated by Fluxlink. Re-run: node ${path.join(root, "bin", "fluxlink.js")} --install
exec ${quoteExec(process.execPath)} ${quoteExec(path.join(root, "bin", "fluxlink.js"))} --daemon --yes "$@"
`,
		0o755,
	);
	log(`wrapper app: ${appDir}`);
	log("macOS cannot shadow /Applications/Fluxer.app without admin; launch Fluxlink.app instead.");

	if (autostart) {
		const agentDir = path.join(os.homedir(), "Library", "LaunchAgents");
		const agent = path.join(agentDir, "dev.fluxlink.launcher.plist");
		ensureDir(agentDir);
		writeManaged(
			manifest,
			agent,
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.fluxlink.launcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(root, "bin", "fluxlink.js")}</string>
    <string>--daemon</string>
    <string>--yes</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`,
			0o644,
		);
		log(`autostart: ${agent}`);
	}

	writeManifest(manifest);
	return {wrapper: appDir, entries: 1, autostart};
}

/* --------------------------------------------------------------- lifecycle */

export function installFluxlink({root, autostart = false, start = false, bin = null}) {
	const current = readManifest();
	if (current && current.created && current.created.length) {
		log("existing install detected; refreshing entries");
		uninstallFluxlink({root, quiet: true, stopLoader: false});
	}
	let result;
	if (process.platform === "win32") result = installWindows({root, autostart, bin});
	else if (process.platform === "darwin") result = installMac({root, autostart, bin});
	else result = installLinux({root, autostart, bin});

	log("installed.");
	log("Launch Fluxer normally and the plugin is injected; no terminal needed.");
	if (start) {
		log("starting Fluxer through Fluxlink now...");
		try {
			const child = spawn(process.execPath, [path.join(root, "bin", "fluxlink.js"), "--daemon", "--yes"], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.unref();
		} catch (err) {
			log(`could not start: ${err.message}`);
		}
	}
	return result;
}

export function uninstallFluxlink({root, quiet = false, stopLoader = true} = {}) {
	const manifest = readManifest();
	const say = quiet ? () => {} : log;
	if (stopLoader) stopRunningLoaders();
	if (!manifest || !manifest.created) {
		say("nothing installed.");
		return;
	}
	for (const file of manifest.created || []) {
		try {
			if (manifest.backups && manifest.backups[file]) {
				fs.copyFileSync(manifest.backups[file], file);
				say(`restored: ${file}`);
			} else if (exists(file)) {
				fs.unlinkSync(file);
				say(`removed: ${file}`);
			}
		} catch (err) {
			say(`could not restore ${file}: ${err.message}`);
		}
	}
	const backupDir = path.join(stateDir(), "backup");
	for (const backup of Object.values(manifest.backups || {})) {
		try {
			fs.unlinkSync(backup);
		} catch (_) {}
	}
	try {
		fs.rmdirSync(backupDir);
	} catch (_) {}
	try {
		fs.unlinkSync(path.join(stateDir(), MANIFEST));
	} catch (_) {}
	say("uninstalled.");
}

export function statusFluxlink({root, bin = null, port = Number(process.env.FLUXER_DEBUG_PORT || 9222)}) {
	const manifest = readManifest();
	const wrapper =
		process.platform === "win32"
			? path.join(process.env.LOCALAPPDATA || stateDir(), "Fluxlink", "launch.vbs")
			: process.platform === "darwin"
				? path.join(os.homedir(), "Applications", "Fluxlink.app")
				: path.join(os.homedir(), ".local", "bin", "fluxlink-launch");
	console.log(`platform      ${process.platform}`);
	console.log(`repo          ${root}`);
	console.log(`fluxer        ${bin || "(not found)"}`);
	console.log(`node          ${process.execPath}`);
	console.log(`state dir     ${stateDir()}`);
	console.log(`wrapper       ${wrapper} ${exists(wrapper) ? "(installed)" : "(missing)"}`);
	console.log(`install meta  ${manifest.created ? "present" : "none"}`);
	if (manifest.created) {
		console.log(`managed files ${(manifest.created || []).length}`);
		for (const file of manifest.created) console.log(`  - ${file}`);
	}
	const lock = readLock(lockPath(port));
	console.log(`loader :${port}   ${lock ? `running (pid ${lock.pid})` : "not running"}`);
}
