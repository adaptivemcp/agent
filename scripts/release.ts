/**
 * scripts/release.ts — publish `@adaptivemcp/agent` to npm.
 *
 * The repo had no release script, so releasing was a list of manual steps — and
 * the step that gets skipped is the version bump, because nothing fails until npm
 * answers the PUT with a 403 ("cannot publish over the previously published
 * versions"). This script makes that mistake impossible to ship: it computes the
 * next version, asks the registry whether it already exists, and refuses before
 * building anything.
 *
 * Usage:
 *   node scripts/release.ts patch|minor|major [--otp <CODE>] [--tag]
 *   node scripts/release.ts --version 0.3.0 --otp <CODE> --tag
 *   node scripts/release.ts --dry-run minor        # show the plan; change nothing
 *
 * Flow:
 *   1. require a clean working tree — a release publishes committed work only;
 *   2. compute the next version and refuse if the registry already has it;
 *   3. run the gates (`typecheck`, `test`, `lint`) so a red tree is never published;
 *   4. build and publish with `pnpm publish` (never `npm publish`);
 *   5. with `--tag`, commit the bump and tag it, so the tree is clean afterwards
 *      and the next release starts from a version that matches the registry.
 *
 * Requires: a logged-in npm session (or an `.npmrc` token) and, with 2FA, a fresh
 * `--otp`/`$NPM_OTP`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE = "@adaptivemcp/agent";
const REGISTRY = "https://registry.npmjs.org";

type Bump = "patch" | "minor" | "major";

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

/** The next version for a bump type, ignoring any prerelease suffix. */
function nextVersion(current: string, bump: Bump): string {
  const [major = 0, minor = 0, patch = 0] = current.split("-")[0]!.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Whether the registry already carries this version. */
async function isPublished(version: string): Promise<boolean> {
  const url = `${REGISTRY}/${PACKAGE.replace("/", "%2f")}`;
  const response = await fetch(url);
  if (response.status === 404) return false;
  if (!response.ok) {
    fail(`could not read ${PACKAGE} from the registry (HTTP ${response.status})`);
  }
  const doc = (await response.json()) as { versions?: Record<string, unknown> };
  return Boolean(doc.versions?.[version]);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tag = args.includes("--tag");
  const otpIndex = args.indexOf("--otp");
  const otp = otpIndex >= 0 ? args[otpIndex + 1] : process.env.NPM_OTP;
  const versionIndex = args.indexOf("--version");
  const explicit = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
  const bump = args.find(
    (arg): arg is Bump => arg === "patch" || arg === "minor" || arg === "major",
  );

  if (!explicit && !bump) {
    fail("usage: node scripts/release.ts patch|minor|major [--otp <CODE>] [--tag]");
  }
  if (otpIndex >= 0 && !otp) fail("--otp needs a code");

  const path = join(ROOT, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { name: string; version: string };
  if (manifest.name !== PACKAGE) fail(`unexpected package name: ${manifest.name}`);
  const next = explicit ?? nextVersion(manifest.version, bump!);

  if (output("git", ["status", "--porcelain"]) !== "") {
    fail("the working tree has uncommitted changes; commit or stash them first");
  }
  if (await isPublished(next)) {
    fail(
      `${PACKAGE}@${next} is already on the registry — bump past it ` +
        `(package.json currently says ${manifest.version})`,
    );
  }

  console.log(
    `[release] ${manifest.version} -> ${next}${dryRun ? " (dry run: nothing will change)" : ""}`,
  );
  if (dryRun) return;

  manifest.version = next;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  run("pnpm", ["typecheck"]);
  run("pnpm", ["test"]);
  run("pnpm", ["lint"]);
  run("pnpm", ["build"]);
  run("pnpm", [
    "publish",
    "--access",
    "public",
    // The tree is dirty on purpose by now: package.json carries the new version.
    "--no-git-checks",
    ...(otp ? ["--otp", otp] : []),
  ]);

  if (tag) {
    run("git", ["add", "package.json"]);
    run("git", ["commit", "-S", "-m", `release: ${PACKAGE}@${next}`]);
    run("git", ["tag", `v${next}`]);
    run("git", ["push", "origin", "HEAD", "--follow-tags"]);
  } else {
    console.log(
      `[release] published ${PACKAGE}@${next}. package.json still says ${next} uncommitted — ` +
        "commit it (or re-run with --tag) before the next release.",
    );
  }
}

await main();
