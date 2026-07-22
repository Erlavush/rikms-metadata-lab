import { constants, accessSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
};

export function resolveCommand(command: string): string | null {
  if (!command) return null;
  if (command.includes(path.sep)) {
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue looking through PATH.
    }
  }
  return null;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maximumOutputBytes?: number;
    maximumErrorBytes?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  const resolved = resolveCommand(command);
  if (!resolved) throw new Error(`Required command is unavailable: ${command}`);
  const maximumOutputBytes = options.maximumOutputBytes ?? 12_000_000;
  const maximumErrorBytes = options.maximumErrorBytes ?? 64_000;
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(resolved, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    const finish = (error?: Error, exitCode = -1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, durationMs: Date.now() - started });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${path.basename(command)} exceeded its ${Math.ceil(options.timeoutMs / 1000)} second time limit.`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error(`${path.basename(command)} exceeded the output safety limit.`));
      } else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= maximumErrorBytes) return;
      const remaining = maximumErrorBytes - errorBytes;
      stderr.push(chunk.subarray(0, remaining));
      errorBytes += Math.min(chunk.length, remaining);
    });
    child.on("error", (error) => finish(new Error(`Could not start ${path.basename(command)}: ${error.message}`)));
    child.on("close", (code) => {
      if (settled) return;
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 2_000);
        finish(new Error(`${path.basename(command)} failed with exit code ${exitCode}${detail ? `: ${detail}` : "."}`), exitCode);
      } else finish(undefined, exitCode);
    });
  });
}

export async function commandVersion(
  command: string,
  args: string[] = ["--version"],
  timeoutMs = 5_000,
): Promise<string | null> {
  if (!resolveCommand(command)) return null;
  try {
    const result = await runCommand(command, args, { timeoutMs, maximumOutputBytes: 20_000, maximumErrorBytes: 20_000 });
    return `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim().split(/\r?\n/)[0]?.slice(0, 200) ?? null;
  } catch {
    return null;
  }
}
