/**
 * scripts/release.ts — publish `@adaptivemcp/agent` to npm, in two phases.
 *
 * The phases exist because they have different needs. Checking and building takes
 * minutes and needs no second factor; publishing takes seconds and does. Running
 * them together meant typing an OTP and then waiting — long enough for the code
 * to expire mid-publish. So:
 *
 *   node scripts/release.ts prepare minor      # slow, no OTP: gates, build, version
 *   node scripts/release.ts publish --otp CODE # fast, OTP: publish, commit, tag, notes
 *
 * `prepare` also writes the release notes (from the commits since the last tag),
 * so the messages are never hand-written, and keeps them in `.release/state.json`
 * for `publish` — which means the notes you can read after `prepare` are exactly
 * the ones that end up on the tag and the GitHub Release.
 *
 * Usage:
 *   node scripts/release.ts prepare patch|minor|major [--dry-run]
 *   node scripts/release.ts prepare --version 0.3.0
 *   node scripts/release.ts publish [--otp <CODE>] [--dry-run] [--no-github]
 *   node scripts/release.ts publish [--skip-verify]
 *
 * `prepare` refuses to start on a dirty tree. `publish` refuses if anything but
 * `package.json` has changed since, so a release cannot ship half of something
 * else. Both refuse a version that is already on the registry — the check that
 * turns a 403 from the PUT into a sentence before anything slow happens.
 *
 * **`publish` verifies the outcome before it tags.** A tag is a claim about npm,
 * and the registry is eventually consistent: for seconds after a successful
 * publish the version can still 404. So `publish` waits for the registry to serve
 * it (60s, polling) and, if it never does, stops *before* the commit and tag — no
 * claim was made that is not true, and a re-run finishes the job. `--skip-verify`
 * is only for a machine that cannot read the registry at all.
 *
 * Requires: a logged-in npm session (or an `.npmrc` token), and with 2FA a fresh
 * `--otp`/`$NPM_OTP` for `publish` only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE = "@adaptivemcp/agent";
const REPO = "adaptivemcp/agent";
const STATE_DIR = join(ROOT, ".release");
const STATE_FILE = join(STATE_DIR, "state.json");

type Bump = "patch" | "minor" | "major";

interface ReleaseState {
  version: string;
  /** The tag this release is measured against, when there is one. */
  previous: string;
  /** The release notes, written once by `prepare` and used by `publish`. */
  notes: string;
  head: string;
  preparedAt: string;
}

function fail(message: string): never {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function run(command: string, args: string[]): void {
  console.log(`[release] $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

function output(command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** Like `run`, but a failure is a warning: used for the optional GitHub Release. */
function attempt(command: string, args: string[]): void {
  try {
    run(command, args);
  } catch {
    console.warn(`[release] ${command} ${args.join(" ")} failed — continuing (the tag is pushed)`);
  }
}

function manifestPath(): string {
  return join(ROOT, "package.json");
}

function readManifest(): { name: string; version: string } {
  const manifest = JSON.parse(readFileSync(manifestPath(), "utf8")) as {
    name: string;
    version: string;
  };
  if (manifest.name !== PACKAGE) fail(`unexpected package name: ${manifest.name}`);
  return manifest;
}

function nextVersion(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = current.split("-")[0]!.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function isPublished(version: string): Promise<boolean> {
  return (await registryStatus(version)) === "published";
}

/**
 * Whether `version` is on the registry — and, when it cannot be read, that we do
 * not know.
 *
 * The two callers want different things from "unknown", which is why this is
 * three-valued rather than a boolean. `prepare` must not refuse a release just
 * because the network is down, but a *tag is a claim about npm*: `publish` will
 * not create one until the registry actually serves the version.
 *
 * `npm view --prefer-online` revalidates npm's cached packument, so a version
 * published a moment ago is seen as soon as the registry offers it; the exact
 * `@version` form is the reliable existence check (the `versions` list and the
 * dist-tags lag).
 */
async function registryStatus(version: string): Promise<"published" | "missing" | "unknown"> {
  try {
    const seen = execFileSync(
      "npm",
      ["view", "--prefer-online", `${PACKAGE}@${version}`, "version"],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    // A version that exists returns it; anything else is not the answer we asked
    // for, so do not mistake it for one.
    return seen === version ? "published" : "unknown";
  } catch (error) {
    // `npm view` exits non-zero with E404 for a version that does not exist yet;
    // anything else (offline, auth, a 5xx) means the registry did not answer.
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    return /E404/.test(stderr) ? "missing" : "unknown";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the registry serves `version`, and report whether it did.
 *
 * The registry is eventually consistent: for seconds after a successful publish
 * `npm view` can still 404 (the publish response arrives before the packument is
 * readable). Tagging on the strength of a single read would therefore claim a
 * version nobody can fetch — so poll instead, and let the caller decide.
 */
async function waitForPublished(
  version: string,
  { timeoutMs = 60_000, intervalMs = 3_000 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await registryStatus(version)) === "published") return true;
    if (Date.now() >= deadline) return false;
    console.log(`[release] ${PACKAGE}@${version} is not visible on the registry yet; waiting…`);
    await delay(intervalMs);
  }
}

/**
 * Paths git reports as changed: worktree, index, and untracked.
 *
 * Not parsed out of `git status --porcelain`: counting status characters is a
 * bug waiting to happen (it ate the first letter of `package.json` the first time
 * this ran). Ask git for names directly.
 */
function changedFiles(): string[] {
  const names = [
    output("git", ["diff", "--name-only"]),
    output("git", ["diff", "--name-only", "--cached"]),
    output("git", ["ls-files", "--others", "--exclude-standard"]),
  ]
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/** The tag this release is measured against: the last version tag reachable from HEAD. */
function previousTag(): string | undefined {
  try {
    return output("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
  } catch {
    return undefined;
  }
}

/**
 * Release notes, derived from the commits since the last tag — grouped by
 * conventional-commit type, so nobody has to write them by hand and they cannot
 * drift from what actually shipped.
 */
function releaseNotes(previous: string | undefined, version: string): string {
  const range = previous ? `${previous}..HEAD` : "HEAD";
  const subjects = output("git", ["log", "--no-merges", "--pretty=format:%s", range])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^release:/i.test(line))
    .reverse();

  const features: string[] = [];
  const fixes: string[] = [];
  const other: string[] = [];
  for (const subject of subjects) {
    const match = /^(feat|fix|docs|test|chore|refactor|perf|build|ci)(\([^)]*\))?!?:\s*(.+)$/.exec(
      subject,
    );
    if (!match) {
      other.push(subject);
      continue;
    }
    const [, type, , text = ""] = match;
    const line = text.charAt(0).toUpperCase() + text.slice(1);
    if (type === "feat") features.push(line);
    else if (type === "fix") fixes.push(line);
    else other.push(line);
  }

  const sections: string[] = [`${PACKAGE} ${version}`, ""];
  if (features.length > 0) sections.push("Features", ...features.map((line) => `- ${line}`), "");
  if (fixes.length > 0) sections.push("Fixes", ...fixes.map((line) => `- ${line}`), "");
  if (other.length > 0) sections.push("Other", ...other.map((line) => `- ${line}`), "");
  if (previous) {
    sections.push(`Full diff: https://github.com/${REPO}/compare/${previous}...v${version}`);
  }
  return `${sections.join("\n").trimEnd()}\n`;
}

function readState(): ReleaseState {
  if (!existsSync(STATE_FILE)) {
    fail("no prepared release — run `node scripts/release.ts prepare patch|minor|major` first");
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as ReleaseState;
}

async function prepare(bump: Bump | undefined, explicit: string | undefined, dryRun: boolean) {
  if (!bump && !explicit) {
    fail("usage: node scripts/release.ts prepare patch|minor|major [--version X.Y.Z]");
  }
  const manifest = readManifest();
  const next = explicit ?? nextVersion(manifest.version, bump!);

  if (changedFiles().length > 0) {
    fail("the working tree has uncommitted changes; commit or stash them first");
  }
  if ((await registryStatus(next)) === "published") {
    fail(
      `${PACKAGE}@${next} is already on the registry — choose a later version ` +
        `(package.json currently says ${manifest.version})`,
    );
  }

  const previous = previousTag();
  const notes = releaseNotes(previous, next);
  console.log(`\n[release] notes for ${next} (${previous ?? "first release"}..HEAD):\n`);
  console.log(notes);

  if (dryRun) {
    console.log("[release] dry run: nothing written, nothing built, nothing published");
    return;
  }

  manifest.version = next;
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[release] package.json ${next}`);
  run("pnpm", ["typecheck"]);
  run("pnpm", ["test"]);
  run("pnpm", ["lint"]);
  run("pnpm", ["build"]);

  mkdirSync(STATE_DIR, { recursive: true });
  const state: ReleaseState = {
    version: next,
    previous: previous ?? "",
    notes,
    head: output("git", ["rev-parse", "HEAD"]),
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  console.log(
    `\n[release] prepared ${PACKAGE}@${next} — now, with a fresh OTP:\n` +
      `  node scripts/release.ts publish --otp <CODE>`,
  );
}

async function publish(otp: string | undefined, dryRun: boolean, github: boolean, verify: boolean) {
  const state = readState();
  const manifest = readManifest();
  if (manifest.version !== state.version) {
    fail(
      `package.json says ${manifest.version} but the prepared release is ${state.version}; ` +
        "re-run prepare",
    );
  }
  const unexpected = changedFiles().filter((file) => file !== "package.json");
  if (unexpected.length > 0) {
    fail(
      `unexpected local changes (${unexpected.join(", ")}); ` +
        "a release publishes the prepared tree and nothing else",
    );
  }

  console.log(`[release] ${PACKAGE}@${state.version} (prepared ${state.preparedAt})`);
  if (dryRun) {
    console.log("[release] dry run: would publish, commit the bump, tag, and write the notes");
    return;
  }

  if (await isPublished(state.version)) {
    console.log(
      `[release] ${PACKAGE}@${state.version} is already on the registry — ` +
        "finishing the commit, tag and notes",
    );
  } else {
    run("pnpm", [
      "publish",
      "--access",
      "public",
      // package.json carries the new version, so the tree is dirty by design.
      "--no-git-checks",
      ...(otp ? ["--otp", otp] : []),
    ]);
  }

  // The tag is a claim about npm, so make the claim true before making it: a
  // publish that returned success is not yet a version anyone can install. If the
  // registry never serves it, stop *before* the commit and tag — the tree is
  // still the prepared tree, and a re-run takes the "already published" branch.
  if (verify && !(await waitForPublished(state.version))) {
    fail(
      `${PACKAGE}@${state.version} was published but is not visible on the registry — ` +
        "the commit and tag were NOT created; re-run publish once the registry catches " +
        "up (or pass --skip-verify if the registry cannot be read from here)",
    );
  }

  const notesFile = join(STATE_DIR, `notes-v${state.version}.md`);
  writeFileSync(notesFile, state.notes);
  run("git", ["add", "package.json"]);
  run("git", ["commit", "-S", "-m", `release: ${PACKAGE}@${state.version}`]);
  // `-F`, not a bare tag: with `tag.gpgSign` set, a tag without a message opens an
  // editor and blocks. The notes become the tag message and the Release body.
  run("git", ["tag", "-F", notesFile, `v${state.version}`]);
  run("git", ["push", "origin", "HEAD", "--follow-tags"]);

  if (github) {
    attempt("gh", [
      "release",
      "create",
      `v${state.version}`,
      "--repo",
      REPO,
      "--title",
      `${PACKAGE} ${state.version}`,
      "--notes-file",
      notesFile,
    ]);
  }

  rmSync(STATE_DIR, { recursive: true, force: true });
  console.log(`\n[release] done: ${PACKAGE}@${state.version}, tag v${state.version}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0];
  const rest = args.slice(1);
  const dryRun = args.includes("--dry-run");
  const github = !args.includes("--no-github");
  // Verification is the default; the escape is for a registry this machine cannot
  // read (an air-gapped or proxied release), not for a hurry.
  const verify = !args.includes("--skip-verify");
  const otpIndex = args.indexOf("--otp");
  const otp = otpIndex >= 0 ? args[otpIndex + 1] : process.env.NPM_OTP;
  const versionIndex = args.indexOf("--version");
  const explicit = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
  const bump = rest.find(
    (arg): arg is Bump => arg === "patch" || arg === "minor" || arg === "major",
  );

  if (otpIndex >= 0 && !otp) fail("--otp needs a code");

  if (mode === "prepare") {
    await prepare(bump, explicit, dryRun);
    return;
  }
  if (mode === "publish") {
    if (bump || explicit)
      fail("`publish` takes no version argument; versions are chosen by `prepare`");
    await publish(otp, dryRun, github, verify);
    return;
  }
  fail(
    "usage:\n" +
      "  node scripts/release.ts prepare patch|minor|major [--dry-run]\n" +
      "  node scripts/release.ts publish [--otp <CODE>] [--dry-run] [--no-github] [--skip-verify]",
  );
}

await main();
