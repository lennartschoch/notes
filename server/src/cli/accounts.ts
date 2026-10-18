import {
  accountCount,
  createAccount,
  listAccounts,
  removeAccount,
  setPassword,
  temporaryPassword,
  initAccounts,
} from "../accounts.js";
import { revokeSessions } from "../sessions.js";

// The accounts command line: `npm run accounts -w server -- <command>`.
//
// Accounts are made here rather than by a signup page because a self-hosted notes
// app has no way to check that an email address belongs to anybody, and an
// installation on a LAN does not want a door that lets a stranger ask to be let in.
// Whoever runs the container decides who has an account, which is the job an
// Access policy does for a hosted one.
//
// It reads and writes the same files the server does, so run it where those files
// are: `docker compose exec notes node server/dist/cli/accounts.js list`.

interface Flags {
  name: string;
  password: string;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { name: "", password: "" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--name") flags.name = args[++i] ?? "";
    else if (arg === "--password") flags.password = args[++i] ?? "";
  }
  return flags;
}

const USAGE = `notes accounts <command>

  add <email> [--name <name>] [--password <password>]   create an account
  list                                                  show every account
  passwd <email> [--password <password>]                replace a password
  remove <email>                                        delete an account

Without --password a one-time password is made and printed: this command runs
where the notes already are, and printing the password it cannot show later is
better than storing a person's chosen one in shell history.`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const email = rest[0] ?? "";
  const flags = parseFlags(rest.slice(1));
  await initAccounts();

  if (command === "add") {
    if (!email) throw new Error("add needs an email address");
    const result = await createAccount(email, flags.password, flags.name);
    if (result.status === "exists") {
      console.error(`An account for ${email} already exists.`);
      return 1;
    }
    if (result.status === "weak") {
      console.error(`That password will not do: ${result.problem}`);
      return 1;
    }
    console.log(`Created ${result.email}.`);
    console.log(`Sign in with this password — it is not stored anywhere else:`);
    console.log(`  ${result.password}`);
    console.log("Change it under the account menu once signed in.");
    console.log(
      "A notes app already running notices this within a couple of seconds.",
    );
    return 0;
  }

  if (command === "list") {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      console.log("No accounts yet. `add <email>` makes the first one.");
      return 0;
    }
    for (const account of accounts) {
      const state = account.active ? "" : "  (not active)";
      const signedIn = account.usage.signedInAt
        ? `last signed in ${account.usage.signedInAt} from ${account.usage.signedInFrom ?? "unknown"}`
        : "never signed in";
      console.log(
        `${account.email}${account.name ? ` — ${account.name}` : ""}${state}\n    made ${account.createdAt} by ${account.createdBy}; ${signedIn}`,
      );
    }
    console.log(`${accounts.length} account(s), ${accountCount()} active.`);
    return 0;
  }

  if (command === "passwd") {
    if (!email) throw new Error("passwd needs an email address");
    const secret =
      flags.password.length > 0 ? flags.password : temporaryPassword();
    if (!(await setPassword(email, secret))) {
      console.error(`No account for ${email}.`);
      return 1;
    }
    // A password someone else set is a session somebody else opened.
    const ended = await revokeSessions(email);
    console.log(`New password for ${email}:`);
    console.log(`  ${secret}`);
    console.log(
      `${ended} sign-in${ended === 1 ? "" : "s"} ended${flags.password.length > 0 ? "" : " (a one-time password was made for you)"}.`,
    );
    return 0;
  }

  if (command === "remove") {
    if (!email) throw new Error("remove needs an email address");
    const result = await removeAccount(email);
    if (result.status === "not_found") {
      console.error(`No account for ${email}.`);
      return 1;
    }
    const ended = await revokeSessions(email);
    console.log(`Removed ${email}; ${ended} sign-in(s) ended.`);
    console.log(
      "Their notes were left where they are: an owner is an email address, and nothing here deletes one person's work because one person left.",
    );
    return 0;
  }

  console.log(USAGE);
  return command === undefined || command === "help" ? 0 : 1;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(String(error instanceof Error ? error.message : error));
  return 1;
});
