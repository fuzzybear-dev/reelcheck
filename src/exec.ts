import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run a binary without a shell. Rejects on non-zero exit, timeout or abort. */
export function exec(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal: opts.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      // ffmpeg filter logs can be large; keep the tail only.
      if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        reject(new Error(`${cmd} exited with ${code ?? sig}: ${tail}`));
      }
    });
  });
}
