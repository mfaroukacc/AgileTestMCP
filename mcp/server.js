#!/usr/bin/env node
// Imported by package name, not by reaching into node_modules. The previous
// form ("../node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js")
// hard-coded the installed SDK's internal dist layout, so any SDK upgrade that
// moved a file would break startup with an unresolvable import on a machine
// that had no reason to touch this code.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { AgileTestTools } from "./agiletest/tools.js";
import { JiraTools } from "./jira/tools.js";
import { ENV_FILE, REPO_ROOT } from "../src/core/paths.js";
import { getBuildInfo } from "../src/core/pipeline/fingerprint.js";

// Load .env from an absolute path. dotenv resolves its default path against
// process.cwd(), which is the user's home folder when an MCP client spawns this
// process. The file silently fails to load and every credential comes back
// undefined, so failures look like bad API tokens rather than a missing config.
dotenv.config({ path: ENV_FILE });

const server = new McpServer({ name: "testcase-creator-mcp", version: "0.1.0" });

console.error(
  `[testcase-creator-mcp] starting build ${getBuildInfo().hash} from ${REPO_ROOT}`,
);

// Wrap all tool registrations with logging so we can see which MCP tool
// was called, with which input, and whether it succeeded or failed.
// Logs go to stderr (console.error) so they don't interfere with MCP protocol messages.
//
// The tool files call `server.tool(name, { description, inputSchema, outputSchema, handler })`.
// The MCP SDK's `tool()` method does NOT support that single config-object signature - it
// would treat the whole object as the callback and register empty input schemas, making every
// tool call fail with "handler is not a function". We therefore bridge to the SDK's
// `server.registerTool(name, config, callback)` API instead.
server.tool = (name, def) => {
  const origHandler = def.handler;
  if (typeof origHandler !== "function") {
    throw new Error('Tool "' + name + '" must define a handler function.');
  }

  const wrappedHandler = async (input, ...rest) => {
    console.error(
      '[testcase-creator-mcp] Calling tool "' + name + '" with input:',
      input,
    );
    try {
      const result = await origHandler(input, ...rest);
      console.error(
        '[testcase-creator-mcp] Tool "' + name + '" succeeded',
      );
      // MCP requires a CallToolResult with a `content` array. Convert plain
      // object/string results into the expected shape.
      if (
        result &&
        typeof result === "object" &&
        !Array.isArray(result) &&
        Array.isArray(result.content)
      ) {
        return result;
      }
      const text =
        typeof result === "string"
          ? result
          : JSON.stringify(result ?? null, null, 2);
      return {
        content: [{ type: "text", text }],
        structuredContent:
          result && typeof result === "object" && !Array.isArray(result)
            ? result
            : undefined,
      };
    } catch (err) {
      console.error(
        '[testcase-creator-mcp] Tool "' + name + '" failed:',
        err?.response?.data || err?.message || err,
      );
      throw err;
    }
  };

  // `outputSchema` is intentionally omitted: the SDK only accepts zod primitives
  // for output schemas, and passing them would trigger output validation on every
  // call. Plain results are returned as text content instead.
  return server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
    },
    wrappedHandler,
  );
};

// Register AgileTest tools
AgileTestTools.register(server);

// Register Jira tools
JiraTools.register(server);

const REQUIRED_ENV = [
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
  "JIRA_PROJECT_KEY",
  "JIRA_STORY_KEY",
  "JIRA_TESTCASE_ISSUETYPE_NAME",
  "AGILETEST_CLIENT_ID",
  "AGILETEST_CLIENT_SECRET",
  "AGILETEST_PROJECT_ID",
];

// Fail loudly at startup rather than mid-pipeline. Without this, a missing
// .env surfaces as an opaque 401 from Jira partway through a run, after the
// pipeline has already created test cases.
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);

// --check validates the install and exits: paths, build hash, required config,
// and a tool count. It makes no API calls. This is the first thing to run when
// the server will not come up on a new machine, and it is safe to run anywhere.
if (process.argv.includes("--check")) {
  const build = getBuildInfo();
  const say = (m) => console.error(`[testcase-creator-mcp] ${m}`);
  say(`repo root      ${REPO_ROOT}`);
  say(`env file       ${ENV_FILE}${missing.length ? "  (incomplete)" : "  (all required keys present)"}`);
  say(`build          ${build.hash}${build.stale ? "  (STALE: code changed after load)" : ""}`);
  say(`default story  ${process.env.JIRA_STORY_KEY || "(none)"}`);
  say(`dryRun default true - call push_test_cases without arguments to preview`);
  if (missing.length) {
    say(`Cannot start: missing ${missing.join(", ")}.`);
    say("Copy .env.example to .env and fill in the values.");
    process.exit(1);
  }
  say("OK. Start the stdio server with: node mcp/server.js");
  process.exit(0);
}

if (missing.length) {
  console.error(
    `[testcase-creator-mcp] Cannot start: missing ${missing.join(", ")}.\n` +
      `[testcase-creator-mcp] Expected a .env at: ${ENV_FILE}\n` +
      `[testcase-creator-mcp] Copy .env.example to .env and fill in the values.\n` +
      `[testcase-creator-mcp] Run "npm run mcp:check" to diagnose.`,
  );
  process.exit(1);
}

const transport = new StdioServerTransport();

async function main() {
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server failed: ", err);
  process.exit(1);
});
