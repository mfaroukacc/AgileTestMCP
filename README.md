# testcase-creator-mcp

An MCP server that turns a generated test-case CSV into Jira Test Case issues with
matching AgileTest test cases, steps and preconditions.

Point any MCP client at it and the tools appear in that client. The server is built
to run from **any directory** — it resolves its own config, CSVs and output folder
from its position on disk, not from wherever the client happens to start it.

This repository contains only the server. It was extracted from a larger
integration project; the CLI scripts, one-off utilities and per-story data stayed
behind.

---

## Layout

```
mcp/                     MCP adapter — transport, schemas, logging
  server.js                entry point; --check runs a no-API-call diagnostic
  jira/tools.js            Jira tools
  agiletest/tools.js       AgileTest tools

src/core/                everything that actually does the work
  paths.js                 resolves repo root, CSVs, output dir, .env
  jiraClient.js            Jira REST client
  agiletestClient.js       AgileTest REST client
  pipeline/                orchestration, locking, dedupe, concurrency,
                           CSV read/write, and the stale-code guard

scripts/verify-setup.mjs read-only setup test suite

Generated_Test_Cases/    you put the input CSV here
Execution_Results/       the server writes results here
```

`mcp/` does not run on its own — every import in it resolves into `src/core/`.
Copy the whole repository.

---

## Requirements

- **Node.js 20 or newer** (`node --version`)
- A Jira Cloud site with an API token
- AgileTest client credentials and a project id

---

## Setup

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Then fill in `.env`. Every value in `.env.example` is deliberately blank — it
declares the variable names and documents each one, nothing more.

Check it before going further:

```bash
npm run mcp:check
```

```
repo root      /home/you/testcase-creator-mcp
env file       /home/you/testcase-creator-mcp/.env  (all required keys present)
build          38987a317d82
default story  PROJ-1234
OK. Start the stdio server with: node mcp/server.js
```

It makes no API calls, so it is safe to run on a fresh machine. If a value is
missing it names the exact keys instead of failing later as an opaque 401.

### Variables

| Variable | Required | Notes |
|---|---|---|
| `JIRA_BASE_URL` | yes | include the trailing slash |
| `JIRA_EMAIL` | yes | the account that **owns** the API token |
| `JIRA_API_TOKEN` | yes | secret — not your password |
| `JIRA_PROJECT_KEY` | yes | e.g. `PROJ` |
| `JIRA_STORY_KEY` | yes | default story; overridable per call |
| `JIRA_TESTCASE_ISSUETYPE_NAME` | yes | must match Jira **exactly**; also the delete guard |
| `AGILETEST_CLIENT_ID` | yes | |
| `AGILETEST_CLIENT_SECRET` | yes | secret |
| `AGILETEST_PROJECT_ID` | yes | numeric; **not** the Jira project key |
| `JIRA_ISSUE_LINK_TYPE` | no | defaults to `AgileTest` |
| `JIRA_ASSIGNEE_ACCOUNT_ID` | no | blank skips assignment |
| `JIRA_TESTCASE_PRIORITY_NAME` | no | blank uses Jira's project default |
| `AGILETEST_ALLOW_STALE_CODE` | no | dev escape hatch, see §7 |

`.env.example` is the authoritative reference — it documents where each value
comes from.

---

## Verify the install

```bash
npm run verify
```

22 read-only checks. Structural checks pass with no credentials at all; anything
needing them is reported as `SKIP` rather than `FAIL`, so a fresh clone tells you
what to do next instead of showing a wall of red.

It deliberately launches child processes from your **home directory** to prove the
server does not depend on the working directory, exercises the safe-by-default
rule, and simulates a mid-session code edit to confirm the stale-code guard fires.

---

## Connect an MCP client

The only thing you must get right is an **absolute path** to `mcp/server.js`.

**macOS / Linux** — `~/Library/Application Support/Claude/claude_desktop_config.json`
(or your client's equivalent):

```json
{
  "mcpServers": {
    "testcase-creator": {
      "command": "node",
      "args": ["/home/you/testcase-creator-mcp/mcp/server.js"]
    }
  }
}
```

**Windows** — `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "testcase-creator": {
      "command": "node",
      "args": ["D:\\tools\\testcase-creator-mcp\\mcp\\server.js"]
    }
  }
}
```

The doubled backslashes are JSON escaping, not a typo.

Installed globally instead? `npm install -g .` then use `"command": "testcase-creator-mcp"`.

Restart the client and confirm the server started:

```
[testcase-creator-mcp] starting build 38987a317d82 from /home/you/testcase-creator-mcp
```

---

## Usage

### Everything that writes previews first

The most important thing to know. `dryRun` **defaults to `true`** on all ten
tools that can change Jira or AgileTest, so calling one with no arguments is
always safe.

```jsonc
// 1. Preview — reads the CSV, reads Jira, changes nothing.
{ "tool": "push_test_cases" }

// 2. Apply — only once you have read the plan.
{ "tool": "push_test_cases", "arguments": { "dryRun": false } }
```

### Typical flow

| Step | Tool | Effect |
|---|---|---|
| 1 | `audit_story` | read-only: duplicates, step mismatches, lock state, build hash |
| 2 | `push_test_cases` | preview the plan |
| 3 | `push_test_cases` + `dryRun:false` | apply |

`push_test_cases` is idempotent: existing test cases are matched by summary and
only missing steps are written, so a re-run that changes nothing finishes in
seconds. It refuses to start if another run holds the same story's lock.

### Test executions and test plans

The same preview-first rule applies when you set up the AgileTest side by hand.
`projectId` is optional on every AgileTest tool and falls back to
`AGILETEST_PROJECT_ID`; entity ids can be given either as the AgileTest id or
as the numeric Jira issue id that produced them.

| Step | Tool | Effect |
|---|---|---|
| 1 | `agiletest_create_test_execution` | AgileTest execution for a Jira Test Execution issue |
| 2 | `agiletest_create_test_plan` | AgileTest plan for a Jira Test Plan issue, over a date range |
| 3 | `agiletest_link_test_plan_to_executions` | puts the execution inside the plan (optionally links cases too) |
| 4 | `agiletest_link_testcases_to_execution` | cases belong to the execution, so results land there |
| 5 | `agiletest_link_testcases_to_test_plan` | cases belong to the plan, so plan reporting sees them |
| 6 | `agiletest_get_testcases_for_execution` | read back what is linked and how it ended |
| 7 | `agiletest_export_failed_testcases` | failures only, with Jira keys, as rows + markdown |

Every step above previews first: call it, read `plannedAction`, then call it
again with `dryRun:false`.

### Tools

| Tool | Purpose |
|---|---|
| `push_test_cases` | Full pipeline: Jira + AgileTest, steps, preconditions |
| `jira_run_csv_from_env_story` | Jira phase only |
| `agiletest_run_csv_from_env_story` | AgileTest phase only |
| `jira_agiletest_run_from_env_story` | Alias for `push_test_cases` |
| `audit_story` | Read-only health check |
| `dedupe_story` | Remove duplicate test cases |
| `jira_get_issue` | Fetch one issue |
| `jira_create_testcase` | Create one Jira test case |
| `jira_delete_testcase` | Delete one (issue-type guarded) |
| `jira_delete_testcases` | Delete an explicit list |
| `jira_delete_testcases_range` | Delete a key range |
| `jira_assign_issue` | Assign an issue |
| `jira_link_story_and_testcase` | Link a story and a test case |
| `agiletest_get_jwt` | Fetch an AgileTest token |
| `agiletest_get_testcases_by_issue_ids` | Read cases and steps |
| `agiletest_create_testcases_from_issue_ids` | Create AgileTest cases |
| `agiletest_create_test_step` | Create one step |
| `agiletest_set_precondition` | Set a precondition |
| `agiletest_process_from_issue_ids_and_csv` | Steps + preconditions from a CSV |
| `agiletest_create_test_execution` | Create a test execution (preview first) |
| `agiletest_get_test_executions_by_issue_ids` | Find executions by Jira issue id |
| `agiletest_get_testcases_for_execution` | List an execution's cases and results |
| `agiletest_link_testcases_to_execution` | Put cases in an execution (preview first) |
| `agiletest_create_test_plan` | Create a test plan (preview first) |
| `agiletest_get_test_plans_by_issue_ids` | Find plans by Jira issue id |
| `agiletest_link_test_plan_to_executions` | Assign executions to a plan (preview first) |
| `agiletest_link_testcases_to_test_plan` | Put cases in a plan (preview first) |
| `agiletest_resolve_testcase_by_jira_issue_id` | Wait for the AgileTest sync |
| `agiletest_export_failed_testcases` | Failures of an execution, with Jira keys |

### Deletion

Deletion only ever touches issues whose type equals `JIRA_TESTCASE_ISSUETYPE_NAME`,
so a mis-typed key cannot delete a story or an epic. `jira_delete_testcases_range`
is the sharpest edge — prefer `jira_delete_testcases` with explicit keys.

---

## Input and output

Put your input at:

```
Generated_Test_Cases/<STORY_KEY>_testcases_generated.csv
```

The server writes:

```
Execution_Results/<STORY_KEY>_testcases_results.csv
```

with columns `test_case_name, priority, jira_issue_key, jira_issue_id,
agiletest_testcase_id`, sorted numerically by Jira key. Both directories are
created automatically; the input CSV is yours to provide.

---

## The stale-code guard

A long-running MCP process holds its modules in memory. Edit the code, then call
a tool, and the process can still run the **old** version — which is how
duplicates and unexpected deletions happen.

Every process fingerprints the `.js` files under `src/core/` and `mcp/` at
startup. The pipeline, `dedupe_story` and the delete tools re-check before acting
and refuse with `ESTALECODE`, listing the files that changed.

**Restart your MCP client after editing code.** That is the fix. To bypass
deliberately, set `AGILETEST_ALLOW_STALE_CODE=1` — development only.

---

## Security

- **Never commit `.env`.** It holds a live Jira API token and an AgileTest client
  secret. `.gitignore` covers it; confirm before every push:

  ```bash
  git ls-files --error-unmatch .env && echo "STOP: .env is tracked"
  ```

- **An ignore rule does not protect an already-tracked file.** If `.env` was ever
  committed, untrack it once with `git rm --cached .env`.

- **Secrets in history stay exposed.** Untracking prevents future leaks, not past
  ones. If this repository has ever been public, rotate `JIRA_API_TOKEN` and
  `AGILETEST_CLIENT_SECRET`. Rewriting history with `git filter-repo` or BFG is
  the alternative, but everyone has to re-clone afterwards.

- **Check what you publish.** `npm pack --dry-run` shows exactly what a publish
  would upload.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot start: missing …` | `.env` absent or incomplete. `npm run mcp:check` names the keys. |
| `ERR_MODULE_NOT_FOUND` | Only `mcp/` was copied. Copy the whole repo. |
| `Cannot find module …/node_modules/@modelcontextprotocol/…` | Old install. Run `npm install`. |
| `ESTALECODE` | Code changed after the process started. Restart the MCP client. |
| 401 from Jira | Wrong `JIRA_EMAIL`/`JIRA_API_TOKEN`, or the token expired. |
| `refuses to start: another run holds the lock` | A prior run is active or crashed. See below. |
| `Invalid credential` creating a test case | `JIRA_TESTCASE_ISSUETYPE_NAME` must match exactly. |
| Nothing in the results CSV | It was a dry run, or the run failed partway. Re-run with `dryRun:false`. |

### Locks and crash recovery

Each story gets a lock plus a manifest under `Execution_Results/.state/`, so two
runs cannot write the same story at once and a re-run resumes rather than
duplicating work. A crashed run leaves its lock behind. Confirm no process is
running, then delete that story's lock file. The manifest is safe to keep — it is
what makes the next run idempotent.
