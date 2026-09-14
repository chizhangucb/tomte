/**
 * The Render recipe (#327): the image and the blueprint a maintainer with no
 * always-on machine deploys the heartbeat from, for Render's per-service
 * minimum and no Actions minutes.
 *
 * Neither is built here. Render is a service this repo cannot run in CI and a
 * container build is minutes of one, so what is held is what a maintainer can
 * be wrong about without noticing: a blueprint that names a plan Render does
 * not bill a cron job under, one deploying a branch nobody merges to, a secret
 * committed into the file, an image whose command is not the sender or whose
 * Node cannot strip the types the sender is written in. The cadence is the one
 * thing a passing deploy would still get wrong silently, and `send.test.ts`
 * holds that against the interval constant beside every other copy of it.
 *
 * Read as text rather than parsed: the repo installs no YAML reader, the
 * blueprint is a dozen flat lines, and the assertions below are about what a
 * maintainer's eye would find in it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PING_URL_ENV } from "./ping.ts";

const repoRoot = new URL("../../", import.meta.url);

/** The blueprint Render reads, at the root of the repo because that is the only place it looks. */
const BLUEPRINT = "render.yaml";

/** The environment group a maintainer creates before deploying, and the blueprint's only source of values. */
const ENV_GROUP = "tomte-heartbeat";

/** What the sender takes its token in, which is the variable `gh` itself reads. */
const TOKEN_ENV = "GH_TOKEN";

/** The blueprint's text, which is the whole of what Render is told. */
const blueprint = (): string => fs.readFileSync(new URL(BLUEPRINT, repoRoot), "utf8");

/**
 * The value of a top-level-ish key inside the blueprint's one service, by its
 * name: `plan`, `branch`, `dockerfilePath`. Quotes and a trailing comment are
 * stripped, so `plan: starter # ...` reads as the plan a maintainer is billed
 * under. Undefined when the key is absent, which is how each assertion below
 * names the key it wanted rather than failing on a parse.
 */
const setting = (key: string): string | undefined => {
  const found = [...blueprint().matchAll(new RegExp(String.raw`^\s*-?\s*${key}:\s*"?([^"\n#]+?)"?\s*(?:#.*)?$`, "gm"))];
  assert.ok(found.length <= 1, `${BLUEPRINT} states ${key} ${found.length} times`);
  return found[0]?.[1];
};

test("the blueprint declares one cron job, on the plan Render bills a cron service under", () => {
  // A cron job and not a worker: a worker runs all month and is billed all
  // month, which is the bill this recipe exists to stay under. Starter is what
  // Render's own cron pricing is quoted at, and a blueprint naming a plan that
  // does not exist is refused at deploy time rather than run cheaply.
  assert.equal(setting("type"), "cron", `${BLUEPRINT} declares a cron job`);
  assert.equal(setting("plan"), "starter");
});

test("the blueprint deploys main as it moves, so the host runs the repo as merged", () => {
  // The reason the recipe is a deploy from the repo at all rather than a
  // machine somebody keeps a clone on: a branch left checked out in a clone is
  // exactly what a cloud host cannot have, and a blueprint pinned to a branch
  // nobody merges to would sweep every target from stale code for as long as
  // nobody looked.
  assert.equal(setting("branch"), "main");
  assert.equal(setting("autoDeploy"), "true");
});

test("the blueprint builds the repo's own image, from a Dockerfile this repo carries", () => {
  // The image is what carries Node, `gh` and the repo, so a blueprint pointing
  // at one that is not in the tree is a deploy that fails or, worse, one that
  // succeeds against somebody else's image.
  assert.equal(setting("runtime"), "docker");
  const dockerfile = setting("dockerfilePath");
  assert.ok(dockerfile, `${BLUEPRINT} names the Dockerfile it builds`);
  const path = dockerfile!.replace(/^\.\//, "");
  const tracked = execFileSync("git", ["ls-files", "-z", path], { cwd: fileURLToPath(repoRoot), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.deepEqual(tracked, [path], `${BLUEPRINT} builds ${dockerfile}, which this repo does not track`);
});

test("the blueprint takes every value from the environment group and states none itself", () => {
  // The two things the host holds are a token with write on every target and a
  // ping URL anyone can mark the check up with, so the blueprint is written so
  // that there is nowhere in it for either to be typed. `fromGroup` is that
  // shape: the group is made in Render before the deploy, the file names it,
  // and a maintainer who forgets gets a service that fails its first pass
  // rather than one running on a value out of the repo.
  const text = blueprint();
  const envVars = text.slice(text.indexOf("envVars:"));
  assert.ok(text.includes("envVars:"), `${BLUEPRINT} declares the job's environment`);
  assert.deepEqual(
    [...envVars.matchAll(/^\s*-?\s*fromGroup:\s*"?([^"\n#]+?)"?\s*$/gm)].map(([, group]) => group),
    [ENV_GROUP],
    `${BLUEPRINT} takes its environment from the ${ENV_GROUP} group and nothing else`,
  );
  // Every other way Render takes a variable, refused: `value` is the literal a
  // secret would be committed as, `key` is the name that goes with it, and
  // `generateValue`/`fromService` are values the group does not hold.
  for (const key of ["key", "value", "generateValue", "fromService", "fromDatabase"]) {
    assert.doesNotMatch(envVars, new RegExp(String.raw`^\s*-?\s*${key}:`, "m"), `${BLUEPRINT} sets ${key} on the job's environment`);
  }
  // And the two names themselves, so a blueprint that grew a plaintext token or
  // ping URL beside the group fails here whatever key it used to do it.
  for (const variable of [TOKEN_ENV, PING_URL_ENV]) {
    assert.doesNotMatch(
      text.replace(/#.*$/gm, ""),
      new RegExp(String.raw`${variable}\s*[:=]`),
      `${BLUEPRINT} sets ${variable} itself instead of taking it from the ${ENV_GROUP} group`,
    );
  }
});

/** The image the blueprint builds, which is the whole of what the host is. */
const IMAGE = "deploy/render/Dockerfile";

const image = (): string => fs.readFileSync(new URL(IMAGE, repoRoot), "utf8");

/** The sender, as the repo-relative path every host's command names. */
const SENDER = "factory/heartbeat/send.ts";

test("the image runs a Node new enough to strip the sender's types with nothing installed", () => {
  // The sender is TypeScript run straight, so the floor is the Node that
  // strips types: an older base image builds fine, deploys fine and dies on
  // the first pass with a syntax error in a file nobody edited.
  const base = /^FROM\s+node:(\d+)[.\-a-z\d]*/m.exec(image());
  assert.ok(base, `${IMAGE} builds on an official Node image, whose tag names the version`);
  assert.ok(Number(base![1]) >= 22, `${IMAGE} is built on Node ${base![1]}, which does not strip types`);
});

test("the image proves at build time that it carries gh, since nothing else ever builds it", () => {
  // Every read and every wake goes through `gh`, and this repo builds no image
  // in CI: the first thing that would notice a missing or unrunnable `gh` is a
  // pass on the real host against the real targets. A build-time run of it is
  // the one check that costs nothing and happens anyway, so the recipe carries
  // it and this holds it there.
  assert.match(image(), /^RUN\s+gh\s+--version\s*$/m, `${IMAGE} runs gh once at build time, so a broken install fails the build`);
});

test("the image carries the repo, and its command is the sender", () => {
  // The image is the one interface a host crosses: a container whose command
  // is anything else is a host that runs on a schedule and sweeps nothing. The
  // repo has to be in it too -- the sender reads `targets.ts` off disk -- and a
  // cron job's container is started fresh for each run, so there is no clone
  // step anywhere else to do it.
  const workdir = /^WORKDIR\s+(\S+)\s*$/m.exec(image());
  assert.ok(workdir, `${IMAGE} works out of one directory`);
  assert.match(image(), new RegExp(String.raw`^COPY\s+\.\s+${workdir![1]}\s*$`, "m"), `${IMAGE} copies the repo into ${workdir![1]}`);
  const command = /^CMD\s+(\[.*\])\s*$/m.exec(image());
  assert.ok(command, `${IMAGE} names the command the host runs, in exec form so no shell stands between cron and the sender`);
  assert.deepEqual(JSON.parse(command![1]!), ["node", "--experimental-strip-types", SENDER]);
  assert.ok(fs.existsSync(new URL(SENDER, repoRoot)), `${IMAGE} runs ${SENDER}, which this repo does not carry`);
});

/** The page an adopter deploys from, which is the only instruction the recipe ships with. */
const README = "README.md";

/** The recipe's own heading on that page, the bold lead-in the paragraphs below it belong to. */
const RECIPE_HEADING = "**No always-on machine: run it on Render.**";

/**
 * The cloud recipe as its own text: everything from its heading to the next
 * bold lead-in at the same level, so an assertion about the recipe cannot be
 * satisfied by a word somewhere else on a page this long.
 */
const recipe = (): string => {
  const readme = fs.readFileSync(new URL(README, repoRoot), "utf8");
  const start = readme.indexOf(RECIPE_HEADING);
  assert.notEqual(start, -1, `${README} carries the cloud recipe, under "${RECIPE_HEADING}"`);
  const rest = readme.slice(start + RECIPE_HEADING.length);
  // The next lead-in at the left margin, and not an indented one: the recipe's
  // own steps are indented under the onboarding step it hangs off, so a stop at
  // any bold line would end the section at its first step.
  const next = rest.search(/\n(?:#{1,6} |\d+\. \*\*|\*\*[A-Z])/);
  return next === -1 ? rest : rest.slice(0, next);
};

test("the cloud recipe is what a maintainer does: the group, the check, the blueprint", () => {
  // Acceptance criterion 4. An adopter with no always-on machine has a repo, a
  // Render account and nothing else, and what they can get wrong is skipping a
  // step: a blueprint deployed before the group exists is a service that fails
  // every pass, and a deploy with no check made is a host nobody is watching,
  // which is the failure this whole spec exists to end.
  const text = recipe();
  // The group, by the name the blueprint asks Render for: a group under any
  // other name is a deploy that never finds its token.
  assert.match(text, new RegExp(String.raw`\b${ENV_GROUP}\b`), "the recipe names the environment group to create");
  for (const variable of [TOKEN_ENV, PING_URL_ENV]) {
    assert.match(text, new RegExp(String.raw`\b${variable}\b`), `the recipe says the group holds ${variable}`);
  }
  // The blueprint, by the path Render reads it from.
  assert.match(text, /\brender\.yaml\b/, "the recipe names the blueprint to deploy");
  assert.match(text, /healthchecks\.io/, "the recipe says to make the check that watches the job");
});

test("the cloud recipe says what it costs, since the whole reason to pick it is the bill", () => {
  // A recipe that names a paid service and not its price is one an adopter has
  // to price themselves before they dare run it. The number that matters is the
  // per-service monthly minimum rather than the compute: one pass per interval
  // is minutes of a month, so the minimum is the bill.
  const text = recipe();
  assert.match(text, /\$1\b/, "the recipe names the dollar a month it costs");
  assert.match(text, /minimum/i, "the recipe says the dollar is Render's per-service minimum, not the compute");
});

test("the cloud recipe hands an adopter on another provider back to the command and the contract", () => {
  // The spec's own line: README says what a host needs, not which vendor. This
  // is the one recipe, so it has to say out loud that it is an example of the
  // contract above it rather than the way the heartbeat is run.
  const text = recipe();
  assert.match(text, /provider/i, "the recipe says another provider works too");
  assert.match(text, /what any host needs/i, "the recipe sends an adopter on another provider to the host contract");
});
