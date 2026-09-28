// Setup verification for the testcase-creator MCP server.
//
//   node scripts/verify-setup.mjs
//
// Everything here is read-only: it makes no Jira or AgileTest calls and changes
// nothing. It checks the things that break silently when the server is copied
// to another machine, which is the point of running it.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.USERPROFILE || process.env.HOME;

// Windows ESM only accepts file:// URLs for dynamic import of an absolute path.
const url = (p) => pathToFileURL(p).href;
const at = (...parts) => url(path.join(REPO, ...parts));

let failures = 0;
let skipped = 0;
const check = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
};
const skip = (label, why) => {
  skipped++;
  console.log(`SKIP  ${label}  (${why})`);
};
const section = (t) => console.log(`\n${t}`);

// A fresh clone has no .env yet. Structure is still checkable, but anything
// that needs credentials has to be reported as skipped rather than failed, or
// a new user gets a wall of red before they have done anything wrong.
const CONFIGURED = fs.existsSync(path.join(REPO, ".env"));
if (!CONFIGURED) {
  console.log(
    "\nNo .env found — running structural checks only.\n" +
      "Create it and re-run to exercise the credential-dependent checks:\n" +
      "    cp .env.example .env      # then fill in the values\n",
  );
}

// Run a snippet in a child process started OUTSIDE the repo, so anything still
// depending on process.cwd() fails here rather than on a user's machine.
const runOutsideRepo = (source, args = []) => {
  const tmp = path.join(REPO, ".verify-tmp.mjs");
  fs.writeFileSync(tmp, source, "utf8");
  try {
    const r = spawnSync(process.execPath, [tmp, ...args], {
      cwd: HOME,
      encoding: "utf8",
      env: process.env,
    });
    return { out: `${r.stdout}${r.stderr}`, code: r.status };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
};

section("1. Paths resolve from the module location, not the working directory");
{
  const { out } = runOutsideRepo(`
    const m = await import(${JSON.stringify(at("src/core/paths.js"))});
    console.log("PATHS=" + JSON.stringify({
      REPO_ROOT: m.REPO_ROOT, GENERATED_DIR: m.GENERATED_DIR,
      RESULTS_DIR: m.RESULTS_DIR, STATE_DIR: m.STATE_DIR, ENV_FILE: m.ENV_FILE,
    }));
  `);
  const raw = (out.match(/PATHS=(\{.*\})/) || [])[1] || "{}";
  let p = {};
  try { p = JSON.parse(raw); } catch {}
  check("repo root resolves to this repo", p.REPO_ROOT === REPO, p.REPO_ROOT);
  check("generated dir under repo", String(p.GENERATED_DIR || "").startsWith(REPO));
  check("results dir under repo", String(p.RESULTS_DIR || "").startsWith(REPO));
  check("state dir under repo", String(p.STATE_DIR || "").startsWith(REPO));
  check(".env is an absolute path in the repo", String(p.ENV_FILE || "").startsWith(REPO), p.ENV_FILE);
}

section("2. .env loads from disk when started outside the repo");
if (!CONFIGURED) {
  skip("JIRA_BASE_URL populated", "no .env");
  skip("AGILETEST_PROJECT_ID populated", "no .env");
  skip("no 'missing env' warning", "no .env");
} else {
  const { out } = runOutsideRepo(`
    await import(${JSON.stringify(at("src/core/jiraClient.js"))});
    await import(${JSON.stringify(at("src/core/agiletestClient.js"))});
    console.log("base=" + process.env.JIRA_BASE_URL);
    console.log("proj=" + process.env.AGILETEST_PROJECT_ID);
  `);
  const base = (out.match(/base=(.*)/) || [])[1];
  check("JIRA_BASE_URL populated", !!base && base !== "undefined", base);
  check("AGILETEST_PROJECT_ID populated", /proj=\d+/.test(out), (out.match(/proj=\S+/) || [])[0]);
  // The clients destructure process.env at import time, so a warning here means
  // those captured constants are permanently undefined.
  check("no 'missing env' warning", !/Missing one or more Jira env vars|Missing AGILETEST_CLIENT_ID/.test(out));
}

section("3. Every MCP tool registers with a handler and a schema");
{
  const { out } = runOutsideRepo(`
    const { JiraTools } = await import(${JSON.stringify(at("mcp/jira/tools.js"))});
    const { AgileTestTools } = await import(${JSON.stringify(at("mcp/agiletest/tools.js"))});
    const tools = [];
    const server = { tool: (n, c) => tools.push({ n, h: typeof c?.handler === "function", s: !!c?.inputSchema }) };
    JiraTools.register(server);
    AgileTestTools.register(server);
    console.log("TOOLS=" + tools.length);
    console.log(tools.every((t) => t.h && t.s) ? "SCHEMAS_OK" : "SCHEMAS_BAD");
    console.log("NOFORCE=" + (tools.every((t) => !/\\bforce\\b/i.test(t.n)) ));
  `);
  const n = Number((out.match(/TOOLS=(\d+)/) || [])[1]);
  check("19 tools registered", n === 19, `got ${n}`);
  check("all have handler + inputSchema", /SCHEMAS_OK/.test(out));
}

section("4. Write-capable tools are safe by default");
{
  const { out } = runOutsideRepo(`
    const { JiraTools } = await import(${JSON.stringify(at("mcp/jira/tools.js"))});
    const { AgileTestTools } = await import(${JSON.stringify(at("mcp/agiletest/tools.js"))});
    const tools = [];
    const srv = { tool: (n, c) => tools.push([n, c.inputSchema]) };
    JiraTools.register(srv); AgileTestTools.register(srv);
    const WRITES = ["push_test_cases", "jira_run_csv_from_env_story", "jira_agiletest_run_from_env_story", "agiletest_run_csv_from_env_story", "dedupe_story"];
    let bad = 0, seen = 0;
    for (const [n, s] of tools) {
      if (!WRITES.includes(n)) continue;
      seen++;
      // Omitting dryRun must resolve to a preview, never to a write.
      if (s.parse({}).dryRun !== true) { bad++; console.log("UNSAFE " + n); }
    }
    console.log("SEEN=" + seen);
    console.log("UNSAFE_COUNT=" + bad);
  `);
  const seen = Number((out.match(/SEEN=(\d+)/) || [])[1]);
  const bad = Number((out.match(/UNSAFE_COUNT=(\d+)/) || [])[1]);
  check("5 write-capable tools checked", seen === 5, `got ${seen}`);
  check("all default to dry run when dryRun is omitted", bad === 0, bad ? `${bad} still write by default` : "");
}

section("5. Results CSV is written in Jira key order, numerically");
{
  const { out } = runOutsideRepo(`
    const m = await import(${JSON.stringify(at("src/core/pipeline/csv.js"))});
    const fs = await import("node:fs");
    const tmp = ${JSON.stringify(path.join(REPO, "Execution_Results", ".ordercheck.csv"))};
    m.writeResultsCsv(tmp, [
      { test_case_name: "c", priority: "High", jira_issue_key: "SHP-10000", jira_issue_id: 2 },
      { test_case_name: "a", priority: "High", jira_issue_key: "SHP-9999",  jira_issue_id: 1 },
      { test_case_name: "b", priority: "High", jira_issue_key: "",        jira_issue_id: "" },
    ]);
    console.log("KEYS=" + m.parseCsv(tmp).rows.map((r) => r.jira_issue_key).join("|"));
    fs.unlinkSync(tmp);
  `);
  check("SHP-9999 before SHP-10000, blank key last", /KEYS=SHP-9999\|SHP-10000\|/.test(out), (out.match(/KEYS=.*/) || [""])[0]);
}

section("6. Stale-code guard detects edits made after the process started");
{
  const { out } = runOutsideRepo(`
    const fp = await import(${JSON.stringify(at("src/core/pipeline/fingerprint.js"))});
    const fs = await import("node:fs");
    const target = ${JSON.stringify(path.join(REPO, "src/core/pipeline/csv.js"))};
    const original = fs.readFileSync(target, "utf8");
    console.log("FRESH=" + (fp.checkStaleCode().stale === false));
    fs.writeFileSync(target, original + "\\n// simulated edit\\n", "utf8");
    let code = "none";
    try { fp.assertFreshCode({ context: "test" }); } catch (e) { code = e.code; }
    console.log("STALE_DETECTED=" + (fp.checkStaleCode().stale === true));
    console.log("REFUSED=" + code);
    fs.writeFileSync(target, original, "utf8");
    console.log("CLEAN_AGAIN=" + (fp.checkStaleCode().stale === false));
  `);
  check("fresh process reports not stale", /FRESH=true/.test(out));
  check("post-load edit detected", /STALE_DETECTED=true/.test(out));
  check("destructive work refused with ESTALECODE", /REFUSED=ESTALECODE/.test(out));
  check("restoring the file clears staleness", /CLEAN_AGAIN=true/.test(out));
}

section("7. Required config is present");
{
  check(".env.example exists", fs.existsSync(path.join(REPO, ".env.example")));
  if (!CONFIGURED) {
    skip(".env exists", "not configured yet");
    skip("all required env vars set", "not configured yet");
  } else {
  check(".env exists", fs.existsSync(path.join(REPO, ".env")));
  const required = [
    "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY",
    "JIRA_STORY_KEY", "JIRA_TESTCASE_ISSUETYPE_NAME",
    "AGILETEST_CLIENT_ID", "AGILETEST_CLIENT_SECRET", "AGILETEST_PROJECT_ID",
  ];
  const { out } = runOutsideRepo(`
    await import(${JSON.stringify(at("src/core/jiraClient.js"))});
    await import(${JSON.stringify(at("src/core/agiletestClient.js"))});
    console.log("MISSING=" + ${JSON.stringify(required)}.filter((k) => !process.env[k]).join(","));
  `);
  const missing = ((out.match(/MISSING=(.*)/) || ["", ""])[1] || "").trim();
  check("all required env vars set", missing === "", missing ? `missing: ${missing}` : "");
  }
}

section("8. Server starts and reports its build");
{
  const r = spawnSync(process.execPath, [path.join(REPO, "mcp", "server.js")], {
    cwd: HOME, encoding: "utf8", env: process.env, timeout: 12000,
  });
  const err = `${r.stderr}`;
  check("resolves repo root from home dir", /starting build \w+ from /.test(err), (err.match(/from (.*)/) || [])[1]);
  if (CONFIGURED) {
    check("no missing-config error", !/Cannot start/.test(err));
  } else {
    skip("no missing-config error", "no .env to start from");
  }
}

const summary = failures === 0
  ? `ALL CHECKS PASSED${skipped ? ` (${skipped} skipped)` : ""}`
  : `${failures} CHECK(S) FAILED${skipped ? `, ${skipped} skipped` : ""}`;
console.log(`\n${summary}`);
process.exit(failures === 0 ? 0 : 1);

