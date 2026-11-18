import { createApp } from "./app.ts";

const baseUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

if (baseUrl === "") {
  process.stderr.write("MAKEFUN_ENV_URL is missing, cannot register with the environment\n");
  process.exit(1);
}

const REQUEST_MS = 30_000;
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function waitFor(attempt: number): number {
  const doubled = FIRST_WAIT_MS * 2 ** Math.min(attempt, 8);
  return Math.min(LONGEST_WAIT_MS, doubled);
}

async function register(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const reply = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_MS),
      });
      if (reply.status === 200 || reply.status === 409) {
        return;
      }
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register failed with HTTP ${reply.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("register failed with HTTP ")) {
        throw err;
      }
    }
    await pause(waitFor(attempt));
    attempt += 1;
  }
}

async function waitDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const reply = await fetch(`${baseUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) {
          return;
        }
      }
    } catch {
      // The environment is not reachable yet; keep polling.
    }
    await pause(waitFor(attempt));
    attempt += 1;
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("server did not bind a TCP port");
  }
  process.stdout.write(`listening on port ${bound.port}\n`);
  await register(bound.port);
  process.stdout.write("registered, waiting for done\n");
  await waitDone();
  server.close();
  process.stdout.write("done\n");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
