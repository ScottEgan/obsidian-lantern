import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile as nativeExecFile } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { execFile, spawn, type ExecFileOptions } from "../../src/qmd/shell";
import { commandEnv } from "../../src/qmd/processEnv";

interface Result {
	error: (Error & { code?: string | number }) | null;
	stdout: string;
	stderr: string;
	calls: number;
}

function run(file: string, args: string[], options: ExecFileOptions = {}): Promise<Result> {
	return new Promise((resolve) => {
		let calls = 0;
		execFile(file, args, options, (error, stdout, stderr) => {
			calls++;
			resolve({ error, stdout, stderr, get calls() { return calls; } });
		});
	});
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const node = (script: string, options: ExecFileOptions = {}) => run(process.execPath, ["-e", script], options);

async function withDeadline<T>(pending: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("fixture did not settle within 10s")), 10000);
		})]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("execFile real processes", () => {
	it("captures stdout and stderr on success", async () => {
		const result = await node('process.stdout.write("out"); process.stderr.write("err")');
		expect(result).toMatchObject({ error: null, stdout: "out", stderr: "err" });
	});

	it("preserves a numeric nonzero exit code and diagnostics", async () => {
		const result = await node('process.stderr.write("bad input"); process.exitCode = 7');
		expect(result.error?.code).toBe(7);
		expect(result.stderr).toBe("bad input");
	});

	it("reports ENOENT for a missing executable", async () => {
		const result = await run(join(tmpdir(), "lantern-missing-executable-36b0a9"), []);
		expect(result.error?.code).toBe("ENOENT");
		await pause(50);
		expect(result.calls).toBe(1);
	});

	it.each(["stdout", "stderr"])("fails on %s byte overflow instead of silently succeeding", async (stream) => {
		const result = await node(`process.${stream}.write("€€€€")`, { maxBuffer: 4 });
		expect(result.error?.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
		expect(result.error?.message).toContain(stream);
		await pause(50);
		expect(result.calls).toBe(1);
	});

	it("decodes UTF-8 characters split across writes on both streams", async () => {
		const result = await node(`
			for (const stream of [process.stdout, process.stderr]) stream.write(Buffer.from([0xe2]));
			setTimeout(() => {
				for (const stream of [process.stdout, process.stderr]) stream.write(Buffer.from([0x82, 0xac]));
			}, 100);
		`);
		expect(result).toMatchObject({ error: null, stdout: "€", stderr: "€" });
	});

	it("reports a distinct timeout with partial output and settles once", async () => {
		const result = await node('process.stdout.write("ready"); setInterval(() => {}, 1000)', { timeout: 1000 });
		expect(result.error?.code).toBe("ETIMEDOUT");
		expect(result.error?.message).toContain("1000ms");
		expect(result.stdout).toBe("ready");
		await pause(100);
		expect(result.calls).toBe(1);
	});

	it.each([false, true])("does not hang on inherited output pipes (launcher exits early: %s)", async (exitsEarly) => {
		const directory = mkdtempSync(join(tmpdir(), "lantern direct timeout "));
		const pidFile = join(directory, "child.pid");
		let pid: number | undefined;
		try {
			const result = await withDeadline(node(`
				const child = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
					stdio: ["ignore", "inherit", "inherit"]
				});
				require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
				process.stdout.write("ready");
				${exitsEarly ? "child.unref();" : "setInterval(() => {}, 1000);"}
			`, { timeout: 1000 }));
			pid = Number(readFileSync(pidFile, "utf8"));
			// Some platforms close inherited pipes on launcher exit; otherwise the
			// timeout must close them. Neither case may leave the callback hanging.
			if (exitsEarly) expect([null, "ETIMEDOUT"]).toContain(result.error?.code ?? null);
			else expect(result.error?.code).toBe("ETIMEDOUT");
			expect(result.stdout).toBe("ready");
		} finally {
			if (pid === undefined) {
				try { pid = Number(readFileSync(pidFile, "utf8")); } catch { /* child never started */ }
			}
			if (pid) await cleanupPid(pid);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([0, 3])("settles once across exit/close events (exit %s)", async (code) => {
		const result = await node(`process.exitCode = ${code}`, { timeout: 1000 });
		await pause(100);
		expect(result.calls).toBe(1);
		expect(result.error?.code ?? 0).toBe(code);
	});

	it("does not schedule automatic termination when timeout is zero", async () => {
		const timer = vi.spyOn(window, "setTimeout");
		try {
			const result = await node('setTimeout(() => process.stdout.write("done"), 100)', { timeout: 0 });
			expect(result).toMatchObject({ error: null, stdout: "done" });
			expect(timer).not.toHaveBeenCalled();
		} finally {
			timer.mockRestore();
		}
	});

	it("preserves multi-line arguments on direct executable launches", async () => {
		const args = ['line one\r\nline two\n\nthree', 'Notes on "A & B"', "日本語 €", "%PATH% ! ^ | (x)"];
		const result = await run(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args]);
		expect(result.error).toBeNull();
		expect(JSON.parse(result.stdout)).toEqual(args);
	});
});

// Only kill fixture PIDs we own, never a process name or the user's qmd.
function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function cleanupPid(pid: number): Promise<void> {
	if (!isAlive(pid)) return;
	if (process.platform !== "win32") {
		try { process.kill(pid, "SIGKILL"); } catch { /* fixture already exited */ }
		return;
	}
	await new Promise<void>((resolve) => {
		nativeExecFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
	});
}

describe.skipIf(process.platform !== "win32")("Windows package-manager shims", () => {
	let directory: string;
	let echoScript: string;
	const shims: Record<string, string> = {};
	const literalArgs = [
		'Notes on "A & B"', "pipe | here", "%PATH%", "caret ^ here", "(parentheses)",
		"日本語 € 😀", "", "trailing\\", "bang ! here", 'x" & echo LANTERN_INJECTED & "y',
	];

	beforeAll(() => {
		directory = mkdtempSync(join(tmpdir(), "lantern shim tests "));
		echoScript = join(directory, "echo.cjs");
		writeFileSync(echoScript, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
		for (const style of ["global-npm", "local-npm", "global-pnpm"]) {
			const path = style === "local-npm"
				? join(directory, "node_modules", ".bin", "lantern-echo.cmd")
				: join(directory, style, "lantern-echo.cmd");
			mkdirSync(dirname(path), { recursive: true });
			// Controlled copies of the npm/pnpm generator templates, forwarding via %*.
			const script = style === "global-pnpm" ? `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe" "${echoScript}" %*
) ELSE (
  "${process.execPath}" "${echoScript}" %*
)
` : `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=${process.execPath}"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%" "${echoScript}" %*
`;
			writeFileSync(path, script.replace(/\n/g, "\r\n"));
			shims[style] = path;
		}
	});

	afterAll(() => rmSync(directory, { recursive: true, force: true }));

	it.each(["global-npm", "local-npm", "global-pnpm"])("preserves literal arguments through an explicit %s shim path with spaces", async (style) => {
		const result = await run(shims[style], literalArgs);
		expect(result.error).toBeNull();
		expect(JSON.parse(result.stdout)).toEqual(literalArgs);
		expect(result.stderr).toBe("");
	});

	it("resolves a bare shim with the supplied augmented PATH, not the parent PATH", async () => {
		const env = commandEnv({ platform: "win32", env: process.env, home: directory, exists: () => true });
		const key = Object.keys(env).find((key) => key.toUpperCase() === "PATH")!;
		env[key] = `${dirname(shims["global-npm"])};${env[key]}`;
		const result = await run("lantern-echo", literalArgs, { env, cwd: directory });
		expect(result.error).toBeNull();
		expect(JSON.parse(result.stdout)).toEqual(literalArgs);
	});

	it.each(["global-npm", "local-npm", "global-pnpm"])("flattens only CR/LF runs on the %s shim route", async (style) => {
		const args = ['line one\r\nline two\n\nNotes on "A & B"', 'line three\rx" & echo LANTERN_INJECTED & "y'];
		const result = await run(shims[style], args);
		expect(result.error).toBeNull();
		expect(JSON.parse(result.stdout)).toEqual(['line one line two Notes on "A & B"', 'line three x" & echo LANTERN_INJECTED & "y']);
		expect(result.stderr).toBe("");
	});

	it("does not execute an attempted extra echo command", async () => {
		const arg = 'x" & echo LANTERN_INJECTED & "y';
		const result = await run(shims["global-npm"], [arg]);
		expect(result).toMatchObject({ error: null, stdout: JSON.stringify([arg]), stderr: "" });
	});

	it.each(["lantern-missing-command-36b0a9", "missing.cmd"])("reports ENOENT for missing Windows command %s", async (name) => {
		const command = name.endsWith(".cmd") ? join(directory, name) : name;
		const result = await run(command, []);
		expect(result.error?.code).toBe("ENOENT");
		await pause(50);
		expect(result.calls).toBe(1);
	});

	it.each(["lantern-missing-command-36b0a9", "missing.cmd"])("spawn reports post-spawn ENOENT for %s", async (name) => {
		const command = name.endsWith(".cmd") ? join(directory, name) : name;
		const events: string[] = [];
		const child = spawn(command, [], { stdio: "ignore" });
		child.once("spawn", () => events.push("spawn"));
		child.on("error", (error: Error & { code?: string }) => events.push(error.code ?? error.message));
		await withDeadline(new Promise<void>((resolve) => child.once("close", () => resolve())));
		expect(events).toEqual(["spawn", "ENOENT"]);
	});

	it.each(["cmd", "bat"])("keeps ordinary .%s launches singly escaped", async (extension) => {
		const path = join(directory, `ordinary.${extension}`);
		writeFileSync(path, '@echo off\r\necho %1\r\n');
		const result = await run(path, ["hello & world"]);
		expect(result).toMatchObject({ error: null, stdout: '"hello & world"\r\n', stderr: "" });
	});

	it("spawn uses the same shim translation without breaking detached launch behavior", async () => {
		const output = join(directory, "detached.json");
		const script = join(directory, "detached.cjs");
		const shim = join(directory, "detached.cmd");
		writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`);
		writeFileSync(shim, readFileSync(shims["global-npm"], "utf8").split(echoScript).join(script));
		// Detached Windows launches should not depend on inherited console pipes.
		const child = spawn(shim, literalArgs, { detached: true, stdio: "ignore" });
		await new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
		});
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(literalArgs);
	});

	it.each(["timeout", "stdout overflow", "stderr overflow"])("stops the actual fixture child on %s and settles once", async (failure) => {
		const pidFile = join(directory, `${failure}.pid`);
		const script = join(directory, `${failure}.cjs`);
		writeFileSync(script, `
			require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
			process.stdout.write("ready");
			${failure === "timeout" ? "" : `setTimeout(() => process.${failure.startsWith("stdout") ? "stdout" : "stderr"}.write("x".repeat(4096)), 50);`}
			setInterval(() => {}, 1000);
		`);
		let pid: number | undefined;
		try {
			// Use the same recognized shim contract for a controlled long-lived child.
			const shim = join(directory, `${failure}.cmd`);
			writeFileSync(shim, readFileSync(shims["global-npm"], "utf8").split(echoScript).join(script));
			const result = await withDeadline(run(shim, [], { timeout: 2000, maxBuffer: failure === "timeout" ? 1024 : 64 }));
			pid = Number(readFileSync(pidFile, "utf8"));
			expect(result.error?.code).toBe(failure === "timeout" ? "ETIMEDOUT" : "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
			for (let attempt = 0; attempt < 40 && isAlive(pid); attempt++) await pause(50);
			expect(isAlive(pid)).toBe(false);
			expect(result.stdout).toContain("ready");
			await pause(100);
			expect(result.calls).toBe(1);
		} finally {
			if (pid === undefined) {
				try { pid = Number(readFileSync(pidFile, "utf8")); } catch { /* child never started */ }
			}
			if (pid) await cleanupPid(pid);
		}
	});

	it("does not terminate a successfully detached fixture daemon after its launcher exits", async () => {
		const pidFile = join(directory, "daemon.pid");
		const daemon = join(directory, "daemon.cjs");
		const launcher = join(directory, "launcher.cjs");
		const shim = join(directory, "launcher.cmd");
		writeFileSync(daemon, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`);
		writeFileSync(launcher, `
			const child = require("child_process").spawn(process.execPath, [${JSON.stringify(daemon)}], {
				detached: true, stdio: "ignore", windowsHide: true
			});
			require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
			child.unref();
		`);
		writeFileSync(shim, readFileSync(shims["global-npm"], "utf8").split(echoScript).join(launcher));
		let pid: number | undefined;
		try {
			const child = spawn(shim, [], { detached: true, stdio: "ignore" });
			await withDeadline(new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
			}));
			for (let attempt = 0; attempt < 40 && pid === undefined; attempt++) {
				try { pid = Number(readFileSync(pidFile, "utf8")); } catch { await pause(50); }
			}
			expect(pid).toBeGreaterThan(0);
			expect(isAlive(pid!)).toBe(true);
		} finally {
			if (pid === undefined) {
				try { pid = Number(readFileSync(pidFile, "utf8")); } catch { /* child never started */ }
			}
			if (pid) await cleanupPid(pid);
		}
	});

	it("keeps timeout failure visible if taskkill cannot launch, and settles once", async () => {
		const pidFile = join(directory, "cleanup failure.pid");
		const script = join(directory, "cleanup failure.cjs");
		const shim = join(directory, "cleanup failure.cmd");
		writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`);
		writeFileSync(shim, readFileSync(shims["global-npm"], "utf8").split(echoScript).join(script));
		const systemRoot = process.env.SystemRoot;
		const env = { ...process.env }; // Only the cleanup executable path is invalid.
		let pid: number | undefined;
		try {
			process.env.SystemRoot = join(directory, "nonexistent Windows");
			const result = await withDeadline(run(shim, [], { timeout: 1000, env }));
			pid = Number(readFileSync(pidFile, "utf8"));
			expect(result.error?.code).toBe("ETIMEDOUT");
			expect(result.error?.message).toContain("process-tree cleanup failed");
			await pause(100);
			expect(result.calls).toBe(1);
		} finally {
			if (systemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = systemRoot;
			if (pid === undefined) {
				try { pid = Number(readFileSync(pidFile, "utf8")); } catch { /* child never started */ }
			}
			if (pid) await cleanupPid(pid);
		}
	});
});
