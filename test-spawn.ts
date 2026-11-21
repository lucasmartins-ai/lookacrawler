// Test-only helper: run `bun cli.ts` in a child and collect its output.
// CI failed at random on spawned CLI children (3 of 12 runs, 21/11/2026; a different test each time).
// Measured on CI: the child had exited (zombie, both pipes at EOF) but `proc.exited` inside `bun test`
// never resolved, while 1,600 spawns of the same commands from bash never hung. So the CLI is fine and
// the test runner misses an exit now and then. Workaround: when both pipes are closed and no exit
// arrives within EXIT_GRACE_MS, log it and run the command once more. A child that is still alive with
// open pipes is a real hang: it is never retried and fails with its process state and output so far.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

export type CliResult = { code: number; stdout: string; stderr: string };

const EXIT_GRACE_MS = 2_000;
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

type Opts = { env?: Record<string, string | undefined>; stdin?: string; deadlineMs?: number };

async function spawnOnce(args: string[], opts: Opts): Promise<CliResult | "missed_exit"> {
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
  let code: number | null = null;
  const exit = proc.exited.then((c) => {
    exited = true;
    code = c;
  });
  exit.catch(() => {});
  let settled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const after = <T>(ms: number, value: T) =>
    new Promise<T>((resolve) => {
      if (!settled) timers.push(setTimeout(resolve, ms, value));
    });

  const pipesThenExit = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err)]).then(() =>
    Promise.race([exit.then(() => "ok" as const), after(EXIT_GRACE_MS, "missed_exit" as const)])
  );
  let outcome: "ok" | "missed_exit" | "deadline";
  try {
    outcome = await Promise.race([pipesThenExit, after(opts.deadlineMs ?? DEADLINE_MS, "deadline" as const)]);
  } catch (e) {
    proc.kill("SIGKILL");
    throw e;
  } finally {
    settled = true;
    timers.forEach(clearTimeout);
  }

  if (outcome === "ok") return { code: code ?? proc.exitCode ?? -1, stdout: out.text, stderr: err.text };
  const state = processState(proc.pid);
  // Retry only a child that really ended (zombie, or already reaped); one still alive is a real hang.
  const ended = /^state=(Z|gone)/.test(state);
  proc.kill("SIGKILL");
  if (outcome === "missed_exit" && ended) {
    console.warn(`test-spawn: exit not observed for bun cli.ts ${args.join(" ")} (pid=${proc.pid} ${state}); re-running`);
    return "missed_exit";
  }
  throw new Error(
    `CLI child hung: bun cli.ts ${args.join(" ")}\n` +
      `parent saw: stdoutClosed=${out.closed} stderrClosed=${err.closed} exited=${exited} exitCode=${proc.exitCode}\n` +
      `child: pid=${proc.pid} ${state}\n` +
      `stdout so far: ${JSON.stringify(out.text.slice(-500))}\n` +
      `stderr so far: ${JSON.stringify(err.text.slice(-500))}`
  );
}

export async function runCli(args: string[], opts: Opts = {}): Promise<CliResult> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await spawnOnce(args, opts);
    if (r !== "missed_exit") return r;
  }
  throw new Error(`CLI exit not observed twice in a row: bun cli.ts ${args.join(" ")}`);
}
