// Test-only helper: run `bun cli.ts` in a child and collect its output.
// CI hangs at random in spawned CLI children (3 of 12 runs, 21/11/2026; a different test each time).
// The deadline sits under the test timeout so a hang fails here with evidence instead of a bare
// "timed out": which of stdout/stderr/exit the parent saw, the child's process state, and the
// output so far. That tells "child stuck" apart from "parent missed the exit".
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export type CliResult = { code: number; stdout: string; stderr: string };

const DEADLINE_MS = Number(process.env.LOOKACRAWLER_TEST_SPAWN_DEADLINE_MS || 10_000);

async function drain(stream: ReadableStream<Uint8Array>, sink: { text: string; closed: boolean }) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) sink.text += decoder.decode(r.value, { stream: true });
  sink.text += decoder.decode();
  sink.closed = true;
}

function processState(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
    let wchan = "";
    try {
      wchan = readFileSync(`/proc/${pid}/wchan`, "utf8");
    } catch {}
    let fds = "";
    try {
      fds = readdirSync(`/proc/${pid}/fd`)
        .map((fd) => {
          try {
            return `${fd}->${readlinkSync(`/proc/${pid}/fd/${fd}`)}`;
          } catch {
            return fd;
          }
        })
        .join(" ");
    } catch {}
    return `state=${state} wchan=${wchan || "?"} fds=[${fds}]`;
  } catch {
    const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
    return `state=${ps.stdout.toString().trim() || "gone"} (no /proc)`;
  }
}

export async function runCli(
  args: string[],
  opts: { env?: Record<string, string | undefined>; stdin?: string; deadlineMs?: number } = {}
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "cli.ts", ...args], {
    cwd: import.meta.dir,
    env: opts.env ?? process.env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = { text: "", closed: false };
  const err = { text: "", closed: false };
  let exited = false;
  const done = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err), proc.exited.then(() => (exited = true))]);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => (timer = setTimeout(resolve, opts.deadlineMs ?? DEADLINE_MS, "deadline")));
  const winner = await Promise.race([done, deadline]);
  clearTimeout(timer);

  if (winner === "deadline") {
    const state = processState(proc.pid);
    proc.kill("SIGKILL");
    throw new Error(
      `CLI child hung: bun cli.ts ${args.join(" ")}\n` +
        `parent saw: stdoutClosed=${out.closed} stderrClosed=${err.closed} exited=${exited} exitCode=${proc.exitCode}\n` +
        `child: pid=${proc.pid} ${state}\n` +
        `stdout so far: ${JSON.stringify(out.text.slice(-500))}\n` +
        `stderr so far: ${JSON.stringify(err.text.slice(-500))}`
    );
  }
  return { code: proc.exitCode ?? -1, stdout: out.text, stderr: err.text };
}
