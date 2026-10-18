import { expect, test, type Page } from "@playwright/test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// Signing in with a password, end to end.
//
// This runs its own server, on its own port, with its own files, and — unlike
// every other spec — *without* DEV_USERS: the dev identity is the app's open door,
// so a test of a locked door cannot stand in front of an open one. Accounts are
// made by the command line a person would use, which also proves that a running
// server notices a file another process wrote.

// A port of its own per run, so a server left over from an interrupted one cannot
// answer for this one: these specs assert on state this file creates.
const PORT = Number(process.env.E2E_SIGNIN_PORT ?? 4200 + (process.pid % 300));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DATA_DIR = join(process.cwd(), "e2e", ".data", "signin");
const PASSWORD = "correct horse battery";

// One account per spec. Failed sign-ins are counted per account — that is the
// feature — so a shared one would have the specs rate-limiting each other, which is
// correct behaviour and a terrible way to observe it.
const NOTES = "notes@example.test"; // the one that signs in and writes
const WRONG = "wrong-password@example.test";
const CHANGED = "password-change@example.test";
const GUESSED = "guessing@example.test";

const run = `${Date.now()}`;

let server: ChildProcessWithoutNullStreams | undefined;

const FILES = {
  NOTES_DATA_FILE: join(DATA_DIR, "notes.json"),
  PUSH_DATA_FILE: join(DATA_DIR, "push.json"),
  API_KEYS_DATA_FILE: join(DATA_DIR, "keys.json"),
  ACCOUNTS_DATA_FILE: join(DATA_DIR, "accounts.json"),
  SESSIONS_DATA_FILE: join(DATA_DIR, "sessions.json"),
};

function startServer(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  server = spawn("npx", ["tsx", "server/src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      // DEV_USERS deliberately unset: nothing but a real credential gets in here.
      ...FILES,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so the `npx` wrapper can be taken down with it.
    detached: true,
  });
  // A beforeAll that fails never reaches afterAll, and the process this file
  // started must not outlive the test run.
  process.once("exit", stopServer);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const timer = setInterval(() => {
      void fetch(`${ORIGIN}/api/health`)
        .then((response) => {
          if (!response.ok) return;
          clearInterval(timer);
          resolve();
        })
        .catch(() => {
          if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error("the sign-in server never answered"));
          }
        });
    }, 250);
  });
}

function stopServer(): void {
  if (!server?.pid) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  server = undefined;
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "server/src/cli/accounts.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...FILES },
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(out || `exit ${code}`)),
    );
  });
}

async function config(): Promise<{ accounts: boolean }> {
  return (await fetch(`${ORIGIN}/api/config`)).json();
}

const signInForm = (page: Page) => page.locator("[data-sign-in]");

async function signInAs(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(ORIGIN);
  await expect(signInForm(page)).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test.beforeAll(async () => {
  await startServer();
  // No accounts yet, so the app has no password door to offer.
  expect((await config()).accounts).toBe(false);

  for (const email of [NOTES, WRONG, CHANGED, GUESSED]) {
    const created = await runCli(["add", email, "--password", PASSWORD]);
    expect(created).toContain(email);
  }
  // The accounts were made by another process, and the server notices the file on a
  // watch rather than a bus: these specs need it to have noticed.
  await expect
    .poll(async () => (await config()).accounts, { timeout: 15_000 })
    .toBe(true);
});

test.afterAll(stopServer);

test("a stranger is met by a door, not by an empty app", async ({ page }) => {
  expect((await fetch(`${ORIGIN}/api/notes`)).status).toBe(401);

  await page.goto(ORIGIN);
  await expect(signInForm(page)).toBeVisible();
  // The app behind it is not so much as rendered: there is nothing to render yet.
  await expect(page.getByRole("button", { name: "New" })).toHaveCount(0);
});

test("a wrong password says only that it was wrong", async ({ page }) => {
  await signInAs(page, WRONG, "not the password at all");
  await expect(page.locator("[data-signin-error]")).toContainText(
    "Wrong email address or password",
  );

  // The same words for an address nobody has here: a login form that could tell
  // them apart is a list of who has an account.
  await signInAs(page, "nobody@example.test", "not the password at all");
  await expect(page.locator("[data-signin-error]")).toContainText(
    "Wrong email address or password",
  );
});

test("a sign-in reaches the notes, and knows its own devices", async ({
  page,
  browser,
}) => {
  const title = `Signed in ${run}`;

  await signInAs(page, NOTES, PASSWORD);
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();

  // The account owns what it writes, exactly as an Access identity would.
  await page.getByRole("button", { name: "New" }).click();
  const editor = page.locator('[aria-label="Note content"]');
  await editor.click();
  await page.keyboard.insertText(`# ${title}`);
  await expect(page.locator('[aria-live="polite"]')).toHaveText("Saved");

  // A second browser is a second device. A sign-in from the *same* user agent
  // replaces the previous session — that is the same tab coming back, not a second
  // device — so this one says what browser it is, the way a real one would.
  const secondContext = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  });
  try {
    const second = await secondContext.newPage();
    await signInAs(second, NOTES, PASSWORD);
    await expect(second.getByRole("button", { name: "New" })).toBeVisible();
    // The note the first browser wrote is there, and the live channel was
    // authenticated by the very cookie the REST calls ride on.
    await second.locator("li").filter({ hasText: title }).first().click();

    await second.getByRole("button", { name: "Account" }).click();
    const devices = second.locator("[data-session]");
    await expect(devices).toHaveCount(2);
    await expect(second.getByText("this device")).toBeVisible();

    // Signing one device out from the other takes it off the list.
    const watched = devices.filter({ hasNotText: "this device" }).first();
    second.once("dialog", (dialog) => void dialog.accept());
    await watched.getByRole("button", { name: "Sign out" }).click();
    await expect(devices).toHaveCount(1);

    // And the browser that was signed out lands back at the door on its next try,
    // rather than at an empty app it cannot explain.
    await page.reload();
    await expect(signInForm(page)).toBeVisible({ timeout: 15_000 });
  } finally {
    await secondContext.close();
  }
});

test("a password change signs every device out, this one included", async ({
  page,
}) => {
  const next = `changed ${run}`;
  await signInAs(page, CHANGED, PASSWORD);
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();

  await page.getByRole("button", { name: "Account" }).click();
  await page.getByLabel("Current password").fill(PASSWORD);
  await page.getByLabel("New password").fill(next);
  await page.getByRole("button", { name: "Change password" }).click();

  // Straight back to the door: the credential that opened it is gone, and so is the
  // session it made.
  await expect(signInForm(page)).toBeVisible({ timeout: 15_000 });

  // The old password no longer opens anything.
  await signInAs(page, CHANGED, PASSWORD);
  await expect(page.locator("[data-signin-error]")).toBeVisible();

  await signInAs(page, CHANGED, next);
  await expect(page.getByRole("button", { name: "New" })).toBeVisible();
});

test("guessing is answered with a wait", async ({ request }) => {
  const body = JSON.stringify({ email: GUESSED, password: "not the password" });
  const codes: number[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await request.fetch(`${ORIGIN}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    codes.push(response.status());
  }
  // Four wrong answers are answered as wrong. The fifth fills the measure, and
  // everything after it is a wait rather than an answer.
  expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
  expect(codes.slice(4)).toEqual([429, 429, 429, 429]);

  const blocked = await request.fetch(`${ORIGIN}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: GUESSED, password: PASSWORD }),
  });
  // Even the right password is a wait now — which is the point: the guesser cannot
  // probe for the good one until the clock runs out.
  expect(blocked.status()).toBe(429);
});
