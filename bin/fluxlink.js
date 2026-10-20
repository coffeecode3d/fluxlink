#!/usr/bin/env node
/* Fluxlink — cross-platform launcher
 * SPDX-License-Identifier: MIT
 *
 * Starts the Fluxer desktop client with the Chrome DevTools Protocol enabled,
 * then runs the CDP loader that injects the Broadcast Box plugin.
 *
 * Works on Windows, Linux and macOS. Node 22+ is required.
 */
import {execFileSync, spawn} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import {fileURLToPath} from "node:url";

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const ROOT = path.resolve(HERE, "..");
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`) || args.includes(`-${name[0]}`);
function argValue(name, fallback) {
	const eq = args.find((a) => a.startsWith(`--${name}=`));
	if (eq) return eq.slice(name.length + 3);
	const i = args.indexOf(`--${name}`);
	if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
	return fallback;
}

const PORT = Number(argValue("port", process.env.FLUXER_DEBUG_PORT || 9222));
const API_PORT = Number(argValue("api-port", process.env.FLUXER_BB_API_PORT || 9224));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	console.error(`Invalid CDP port: ${PORT}`);
	process.exit(1);
}
if (!Number.isInteger(API_PORT) || API_PORT < 1 || API_PORT > 65535) {
	console.error(`Invalid plugin-store port: ${API_PORT}`);
	process.exit(1);
}
const ASSUME_YES = has("yes") || has("y");
const ATTACH_ONLY = has("attach");
const CHECK_ONLY = has("check");
const NO_RESTART = has("no-restart");
const VERBOSE = has("verbose");
const PRINT_BIN = has("print-bin");

if (has("help") || has("h")) {
	console.log(`Fluxlink — Broadcast Box bridge for the Fluxer desktop client

Usage:
  fluxlink [options]
  node bin/fluxlink.js [options]

Options:
  -y, --yes            Don't ask before restarting Fluxer
      --attach         Don't launch or restart Fluxer; attach to a running CDP port
      --check          List CDP targets and exit
      --no-restart     Fail instead of restarting a running Fluxer
      --port <n>       CDP port (default 9222, or FLUXER_DEBUG_PORT)
      --api-port <n>   Plugin-store API port (default 9224, or FLUXER_BB_API_PORT)
      --verbose        Show plugin console messages
      --print-bin      Print the detected Fluxer executable and exit
  -h, --help           Show this help
  -v, --version        Show the version

Environment:
  FLUXER_BIN           Path to the Fluxer executable
  FLUXER_DEBUG_PORT    CDP port
  FLUXER_BB_API_PORT   Plugin-store API port

Fluxer must be started with --remote-debugging-port for the loader to attach.
The launcher does that for you; a running Fluxer may need to be restarted.
`);
	process.exit(0);
}

if (has("version") || has("v")) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
		console.log(pkg.version || "0.0.0");
	} catch (_) {
		console.log("0.0.0");
	}
	process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isWindows = process.platform === "win32";

function isExecutable(file) {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return false;
		if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch (_) {
		return false;
	}
}

function findFluxer() {
	if (process.env.FLUXER_BIN) {
		const explicit = path.resolve(process.env.FLUXER_BIN);
		return isExecutable(explicit) ? explicit : null;
	}
	const home = os.homedir();
	const candidates = [];
	if (isWindows) {
		const local = process.env.LOCALAPPDATA;
		const programFiles = process.env.PROGRAMFILES;
		const programFilesX86 = process.env["PROGRAMFILES(X86)"];
		if (local) {
			candidates.push(path.join(local, "Programs", "Fluxer", "Fluxer.exe"));
			candidates.push(path.join(local, "Fluxer", "Fluxer.exe"));
		}
		if (programFiles) candidates.push(path.join(programFiles, "Fluxer", "Fluxer.exe"));
		if (programFilesX86) candidates.push(path.join(programFilesX86, "Fluxer", "Fluxer.exe"));
	} else if (process.platform === "darwin") {
		candidates.push("/Applications/Fluxer.app/Contents/MacOS/Fluxer");
		candidates.push(path.join(home, "Applications", "Fluxer.app", "Contents", "MacOS", "Fluxer"));
	} else {
		candidates.push("/opt/fluxer-bin/fluxer");
		candidates.push("/opt/Fluxer/fluxer");
		candidates.push("/usr/bin/fluxer");
		candidates.push("/usr/local/bin/fluxer");
		candidates.push(path.join(home, ".local", "bin", "fluxer"));
	}
	for (const candidate of candidates) {
		if (isExecutable(candidate)) return candidate;
	}
	const command = isWindows ? "where" : "which";
	const query = isWindows ? ["Fluxer.exe"] : ["fluxer"];
	try {
		const out = execFileSync(command, query, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		for (const line of out.split(/\r?\n/)) {
			const value = line.trim();
			if (value && isExecutable(value)) return value;
		}
	} catch (_) {}
	return null;
}

function fluxerPids(bin) {
	if (isWindows) {
		try {
			const image = path.basename(bin);
			const out = execFileSync(
				"tasklist",
				["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"],
				{encoding: "utf8", windowsHide: true},
			);
			const pids = [];
			for (const line of out.split(/\r?\n/)) {
				const match = /^"([^"]+)","(\d+)"/.exec(line);
				if (match) pids.push(Number(match[2]));
			}
			return pids;
		} catch (_) {
			return [];
		}
	}
	try {
		// Parse comm separately from args. Matching any command line that merely
		// mentions the Fluxer path can catch the shell that started this launcher.
		const out = execFileSync("ps", ["-A", "-o", "pid=,comm=,args="], {encoding: "utf8"});
		const base = path.basename(bin);
		const pids = [];
		for (const line of out.split(/\r?\n/)) {
			const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
			if (!match) continue;
			const pid = Number(match[1]);
			const comm = path.basename(match[2]);
			const argv0 = match[3].split(/\s+/)[0];
			if (pid === process.pid) continue;
			if (comm === base || argv0 === bin || argv0 === base) pids.push(pid);
		}
		return pids;
	} catch (_) {
		return [];
	}
}

async function stopFluxer(bin) {
	const pids = fluxerPids(bin);
	if (!pids.length) return;
	console.log(`Stopping Fluxer (${pids.join(", ")})...`);
	if (isWindows) {
		for (const pid of pids) {
			try {
				execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
				});
			} catch (_) {}
		}
	} else {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGTERM");
			} catch (_) {}
		}
		for (let i = 0; i < 10; i++) {
			await sleep(200);
			if (!fluxerPids(bin).length) break;
		}
		for (const pid of fluxerPids(bin)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch (_) {}
		}
	}
	for (let i = 0; i < 15; i++) {
		if (!fluxerPids(bin).length) return;
		await sleep(200);
	}
}

async function cdpUp(port) {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
			cache: "no-store",
			signal: AbortSignal.timeout(1500),
		});
		return res.ok;
	} catch (_) {
		return false;
	}
}

async function waitForCdp(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await cdpUp(port)) return true;
		await sleep(500);
	}
	return false;
}

function launchFluxer(bin, port) {
	console.log(`Launching Fluxer with CDP on port ${port}...`);
	const child = spawn(
		bin,
		[`--remote-debugging-port=${port}`, "--remote-allow-origins=*"],
		{detached: true, stdio: "ignore", windowsHide: false, cwd: path.dirname(bin)},
	);
	child.unref();
}

function runLoader(extra = []) {
	const loaderArgs = [
		path.join(ROOT, "src", "loader.mjs"),
		"--port",
		String(PORT),
		"--api-port",
		String(API_PORT),
		...extra,
	];
	if (VERBOSE) loaderArgs.push("--verbose");
	const child = spawn(process.execPath, loaderArgs, {
		cwd: ROOT,
		stdio: "inherit",
		windowsHide: false,
	});
	const forward = (signal) => {
		try {
			child.kill(signal);
		} catch (_) {}
	};
	process.on("SIGINT", () => forward("SIGINT"));
	process.on("SIGTERM", () => forward("SIGTERM"));
	child.on("exit", (code, signal) => {
		process.exit(code ?? (signal === "SIGINT" ? 130 : 1));
	});
}

if (PRINT_BIN) {
	const bin = findFluxer();
	console.log(bin || "not found");
	process.exit(bin ? 0 : 1);
}

if (CHECK_ONLY) {
	runLoader(["--check"]);
} else {
	const attach = ATTACH_ONLY;
	if (!attach && (await cdpUp(PORT))) {
		console.log(`Fluxer already exposes CDP on ${PORT} — attaching.`);
	} else if (attach) {
		if (!(await cdpUp(PORT))) {
			console.error(`No CDP endpoint on 127.0.0.1:${PORT}.`);
			console.error("Start Fluxer through this launcher without --attach, then retry.");
			process.exit(1);
		}
	} else {
		const bin = findFluxer();
		if (!bin) {
			console.error("Fluxer executable not found.");
			console.error("Set FLUXER_BIN to the full path, for example:");
			if (isWindows) {
				console.error('  set FLUXER_BIN=%LOCALAPPDATA%\\Programs\\Fluxer\\Fluxer.exe');
			} else {
				console.error("  FLUXER_BIN=/opt/fluxer-bin/fluxer node bin/fluxlink.js");
			}
			process.exit(1);
		}
		if (fluxerPids(bin).length) {
			if (NO_RESTART) {
				console.error("Fluxer is running without remote debugging.");
				console.error("Restart it with --yes, or start it manually with the CDP flags.");
				process.exit(1);
			}
			if (!ASSUME_YES) {
				if (!process.stdin.isTTY) {
					console.error("Fluxer is running without remote debugging.");
					console.error("Re-run with --yes to restart it.");
					process.exit(1);
				}
				const rl = readline.createInterface({input: process.stdin, output: process.stdout});
				const answer = await rl.question("Restart Fluxer now? [y/N] ");
				rl.close();
				if (!/^y(es)?$/i.test(answer.trim())) {
					console.log("Aborted.");
					process.exit(0);
				}
			}
			await stopFluxer(bin);
		}
		launchFluxer(bin, PORT);
		if (!(await waitForCdp(PORT, 30000))) {
			console.error(`CDP port ${PORT} never opened.`);
			console.error("Check that Fluxer launched, then run:");
			console.error(`  node src/loader.mjs --port ${PORT}`);
			process.exit(1);
		}
	}
	runLoader();
}
