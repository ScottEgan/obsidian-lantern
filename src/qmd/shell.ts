/**
 * qmd launch adapter, not an unrestricted Node execFile replacement.
 * Native execFile owns buffering, UTF-8 decoding and command failures. Windows
 * command translation uses pinned cross-spawn 7.0.6 internals, isolated here.
 * Only recognized npm/pnpm %*-forwarding shims get extra argument escaping and
 * CR/LF flattening. Direct executables and POSIX launches stay native.
 */
import crossSpawn from "cross-spawn";
import {
	execFile as nativeExecFile,
	spawn as nativeSpawn,
	type ChildProcess,
	type ExecFileOptions as NativeExecFileOptions,
	type SpawnOptions,
} from "child_process";
import { readFileSync, statSync } from "fs";
import { join, normalize } from "path";
import { command as escapeCommand, argument as escapeArgument } from "cross-spawn/lib/util/escape";

export type ExecFileOptions = Pick<NativeExecFileOptions, "cwd" | "env" | "timeout" | "maxBuffer">;

type ExecError = Error & { code?: string | number };

export type ExecFileCallback = (
	error: ExecError | null,
	stdout: string,
	stderr: string
) => void;

interface ParsedCommand {
	command: string;
	args: string[];
	options: SpawnOptions;
	file?: string;
	original: { command: string; args: string[] };
}

// Private seams are intentional: keep the exact dependency pin and the real-
// process tests when upgrading. Do not expose these internals to qmd callers.
const adapter = crossSpawn as typeof crossSpawn & {
	_parse(file: string, args: string[], options: SpawnOptions): ParsedCommand;
	_enoent: { verifyENOENT(status: number | null | undefined, parsed: ParsedCommand): ExecError | null };
};

/** Recognize generator signatures, not arbitrary batch programs or every .cmd. */
function isPackageManagerShim(file: string): boolean {
	if (!/\.cmd$/i.test(file)) return false;
	try {
		if (statSync(file).size > 16 * 1024) return false;
		const script = readFileSync(file, "utf8");
		const npm = /^@ECHO off\r?\nGOTO start\r?\n/i.test(script)
			&& /CALL :find_dp0/i.test(script)
			&& /"%_prog%"\s+"[^"\r\n]+" %\*\s*$/im.test(script);
		const pnpm = /^@SETLOCAL\r?\n/i.test(script)
			&& /@IF EXIST "%~dp0\\(?:node|bun)\.exe" \(/i.test(script)
			&& /^\s*"%~dp0\\(?:node|bun)\.exe"\s+"[^"\r\n]+" %\*\s*$/im.test(script);
		return npm || pnpm;
	} catch {
		return false; // Missing/unreadable commands keep ordinary ENOENT handling.
	}
}

function translate(file: string, args: string[], options: SpawnOptions): ParsedCommand {
	const parsed = adapter._parse(file, args, options);
	if (process.platform !== "win32") return parsed;
	parsed.options.windowsHide = true;
	if (parsed.options.windowsVerbatimArguments && parsed.file && isPackageManagerShim(parsed.file)) {
		// Rebuild from original args, never re-escape the parser's already escaped
		// args (local node_modules/.bin shims already receive double escaping).
		// Use the actual resolved shim rather than resolving a bare name again.
		const command = escapeCommand(normalize(parsed.file));
		const escaped = args.map((arg) => escapeArgument(arg.replace(/[\r\n]+/g, " "), true));
		parsed.args = ["/d", "/s", "/c", `"${[command, ...escaped].join(" ")}"`];
	}
	return parsed;
}

/** Start a launcher; a spawn event alone does not establish daemon health. */
export function spawn(file: string, args: string[], options: SpawnOptions = {}): ChildProcess {
	const parsed = translate(file, args, options);
	const child = nativeSpawn(parsed.command, parsed.args, parsed.options);
	child.once("exit", (code) => {
		const error = adapter._enoent.verifyENOENT(code, parsed);
		if (error) child.emit("error", error);
	});
	// No termination hooks on detached launches: never kill a healthy daemon.
	return child;
}

/** The callback-based, UTF-8-only subset used by QmdCli. timeout: 0 stays unlimited. */
export function execFile(file: string, args: string[], options: ExecFileOptions, callback: ExecFileCallback): void {
	const { timeout = 0, maxBuffer = 64 * 1024 * 1024, ...launchOptions } = options;
	if (!Number.isInteger(timeout) || timeout < 0) throw new RangeError("timeout must be a non-negative integer");
	const parsed = translate(file, args, launchOptions);
	const windowsShell = process.platform === "win32" && !!parsed.options.windowsVerbatimArguments;
	let timer: number | undefined;
	let completed = false;
	let timeoutError: ExecError | null = null;
	let treeCleanup: Promise<void> | undefined;
	let cleanupFailure: string | undefined;
	const clearTimer = () => {
		if (timer !== undefined) window.clearTimeout(timer);
		timer = undefined;
	};

	const child = nativeExecFile(parsed.command, parsed.args, {
		...parsed.options,
		encoding: "utf8",
		maxBuffer,
		timeout: 0, // Obsidian window timers, and explicit Windows tree termination.
	}, (nativeError, stdout, stderr) => {
		if (completed) return;
		completed = true;
		clearTimer();
		const commandError = nativeError ? Object.assign(nativeError, { code: nativeError.code ?? undefined }) : null;
		const error = timeoutError
			?? adapter._enoent.verifyENOENT(nativeError?.code === 1 ? 1 : child.exitCode, parsed)
			?? commandError;
		const finish = () => {
			if (cleanupFailure && error) error.message += `\nWindows process-tree cleanup failed: ${cleanupFailure}`;
			callback(error, stdout, stderr);
		};
		if (treeCleanup) void treeCleanup.then(finish);
		else finish();
	});

	if (windowsShell) {
		const directKill = child.kill.bind(child) as ChildProcess["kill"];
		// Native execFile calls child.kill on maxBuffer overflow. Intercept that
		// BEFORE cmd.exe dies, while taskkill can still identify its descendants.
		// Buffering/decoding/partial output remain entirely owned by native execFile.
		child.kill = (signal) => {
			if (treeCleanup) return true;
			if (!child.pid || child.exitCode !== null || child.signalCode !== null) return directKill(signal);
			clearTimer();
			treeCleanup = new Promise((resolve) => {
				nativeExecFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
					["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
						if (error) {
							cleanupFailure = error.message;
							// A surviving descendant can hold the pipes open even after
							// cmd.exe dies. Close them so timeout still returns diagnostics.
							child.stdout?.destroy();
							child.stderr?.destroy();
							directKill(signal); // Best effort if tree cleanup itself fails.
						}
						resolve();
					});
			});
			return true;
		};
	}

	if (timeout > 0) {
		timer = window.setTimeout(() => {
			if (completed || child.killed) return;
			timeoutError = Object.assign(new Error(`Command timed out after ${timeout}ms: ${file}`), { code: "ETIMEDOUT" });
			if (!windowsShell || child.exitCode !== null || child.signalCode !== null) {
				// Match native timeout behavior: a descendant holding inherited
				// pipes must not prevent the direct launcher's callback from closing.
				child.stdout?.destroy();
				child.stderr?.destroy();
			}
			child.kill();
		}, timeout);
	}
}
