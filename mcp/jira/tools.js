import { z } from "zod";
import {
  getJiraIssue,
  createJiraTestCase,
  assignJiraIssue,
  linkJiraIssues,
  deleteJiraTestCasesByIds,
} from "../../src/core/jiraClient.js";
import { runJiraPhase } from "../../src/core/pipeline/jiraPhase.js";
import { runPipeline, verifyStory } from "../../src/core/pipeline/index.js";
import { dedupeStory } from "../../src/core/pipeline/dedupe.js";
import { inspectLock } from "../../src/core/pipeline/state.js";
import { formatDuration } from "../../src/core/pipeline/concurrency.js";
import { getBuildInfo, checkStaleCode } from "../../src/core/pipeline/fingerprint.js";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

function expandJiraKeyRange(startKey, endKey) {
  const startMatch = startKey.match(/^(.*-)(\d+)$/);
  const endMatch = endKey.match(/^(.*-)(\d+)$/);

  if (!startMatch || !endMatch) {
    throw new Error(
      "startKey or endKey is not in expected KEY-NUMBER format (e.g. CIR-459).",
    );
  }

  const startPrefix = startMatch[1];
  const startNum = Number(startMatch[2]);
  const endPrefix = endMatch[1];
  const endNum = Number(endMatch[2]);

  if (startPrefix !== endPrefix) {
    throw new Error("startKey and endKey have different prefixes.");
  }
  if (Number.isNaN(startNum) || Number.isNaN(endNum) || endNum < startNum) {
    throw new Error("Invalid numeric range in startKey / endKey.");
  }

  const keys = [];
  for (let n = startNum; n <= endNum; n += 1) {
    keys.push(`${startPrefix}${n}`);
  }
  return keys;
}

// Deletion is the one irreversible operation here, so the type check lives in
// core and this is only an adapter. An earlier copy of the guard lived in this
// file; two guards around a permanent delete means one of them eventually
// drifts and the wrong issue type becomes deletable.
async function deleteSingleJiraIssue(issueIdOrKey) {
  const [result] = await deleteJiraTestCasesByIds({
    ids: [issueIdOrKey],
    log: (msg) => console.error(`[delete] ${msg}`),
  });

  if (!result) {
    return { issueIdOrKey, deleted: false, reason: "no result returned" };
  }
  if (result.deleted) {
    return { issueIdOrKey, deleted: true };
  }
  if (result.reason === "not found") {
    return { issueIdOrKey, deleted: false, reason: "Jira issue not found (404)" };
  }
  return { issueIdOrKey, deleted: false, reason: result.reason };
}

export class JiraTools {
  static register(server) {
    // Tool: get Jira issue
    server.tool("jira_get_issue", {
      description: "Fetch a Jira issue by key or numeric id.",
      inputSchema: z.object({
        issueIdOrKey: z.string().describe("Jira issue key (e.g. CIR-5) or numeric id"),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const issue = await getJiraIssue(input.issueIdOrKey);
        return issue;
      },
    });

    // Tool: create Jira Test Case
    server.tool("jira_create_testcase", {
      description: "Create a Jira Test Case issue and optionally link it to a Story.",
      inputSchema: z.object({
        summary: z.string(),
        description: z.string(),
        storyKey: z.string().optional(),
        priorityName: z.string().optional(),
      }),
      outputSchema: z.object({ key: z.string(), id: z.string() }),
      async handler(input) {
        const result = await createJiraTestCase({
          summary: input.summary,
          description: input.description,
          storyKey: input.storyKey,
          priorityName: input.priorityName,
        });
        return result;
      },
    });

    // Tool: assign Jira issue
    server.tool("jira_assign_issue", {
      description: "Assign a Jira issue to an accountId.",
      inputSchema: z.object({
        issueIdOrKey: z.string(),
        accountId: z.string(),
      }),
      outputSchema: z.object({ success: z.boolean() }),
      async handler(input) {
        await assignJiraIssue({ issueIdOrKey: input.issueIdOrKey, accountId: input.accountId });
        return { success: true };
      },
    });

    // Tool: link Jira Story and Test Case
    server.tool("jira_link_story_and_testcase", {
      description: "Link a Story and Test Case using the configured JIRA_ISSUE_LINK_TYPE.",
      inputSchema: z.object({
        storyKey: z.string(),
        testCaseKey: z.string(),
      }),
      outputSchema: z.object({ success: z.boolean() }),
      async handler(input) {
        await linkJiraIssues({ storyKey: input.storyKey, testCaseKey: input.testCaseKey });
        return { success: true };
      },
    });

    // Tool: delete a single Jira Test Case by key or id
    server.tool("jira_delete_testcase", {
      description:
        "Delete a single Jira Test Case issue by key or id (only if issuetype matches JIRA_TESTCASE_ISSUETYPE_NAME).",
      inputSchema: z.object({
        issueIdOrKey: z.string().describe("Jira issue key (e.g. CIR-459) or numeric id"),
      }),
      outputSchema: z.object({
        issueIdOrKey: z.string(),
        deleted: z.boolean(),
        reason: z.string().optional(),
      }),
      async handler(input) {
        const result = await deleteSingleJiraIssue(input.issueIdOrKey);
        return result;
      },
    });

    // Tool: delete multiple Jira Test Case issues by explicit list of keys/ids
    server.tool("jira_delete_testcases", {
      description:
        "Delete multiple Jira Test Case issues by explicit array of keys/ids (only if issuetype matches JIRA_TESTCASE_ISSUETYPE_NAME).",
      inputSchema: z.object({
        issueIdsOrKeys: z
          .array(z.string())
          .min(1)
          .describe("Array of Jira keys or ids (e.g. [\"CIR-459\",\"CIR-460\"])"),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            issueIdOrKey: z.string(),
            deleted: z.boolean(),
            reason: z.string().optional(),
          }),
        ),
      }),
      async handler(input) {
        const results = [];
        for (const key of input.issueIdsOrKeys) {
          const res = await deleteSingleJiraIssue(key);
          results.push(res);
        }
        return { results };
      },
    });

    // Tool: delete Jira Test Case issues by range (e.g. CIR-459..CIR-472)
    server.tool("jira_delete_testcases_range", {
      description:
        "Delete Jira Test Case issues by key range, e.g. startKey=CIR-459, endKey=CIR-472 (inclusive).",
      inputSchema: z.object({
        startKey: z.string().describe("Starting Jira key in the range (e.g. CIR-459)"),
        endKey: z.string().describe("Ending Jira key in the range (e.g. CIR-472)"),
      }),
      outputSchema: z.object({
        keys: z.array(z.string()),
        results: z.array(
          z.object({
            issueIdOrKey: z.string(),
            deleted: z.boolean(),
            reason: z.string().optional(),
          }),
        ),
      }),
      async handler(input) {
        const keys = expandJiraKeyRange(input.startKey, input.endKey);
        const results = [];
        for (const key of keys) {
          const res = await deleteSingleJiraIssue(key);
          results.push(res);
        }
        return { keys, results };
      },
    });


    // --- Pipeline tools (in-process, idempotent, cancellable) ---

    const requireStoryKey = (input) => {
      const key = (input?.storyKey || process.env.JIRA_STORY_KEY || "").trim();
      if (!key) {
        throw new Error(
          "JIRA_STORY_KEY must be set in environment (.env) or passed as input.storyKey.",
        );
      }
      return key;
    };

    // Tool: push test cases - the main entry point. Idempotent: re-running makes no
    // duplicate test cases and no duplicate steps. Previews by default, so an
    // accidental call cannot write; dryRun=false is the opt-in to apply.
    server.tool("push_test_cases", {
      description:
        "Create or update Jira + AgileTest test cases for a story from its generated CSV.\n" +
        "Safe and fast to re-run: existing test cases are matched by summary, only missing steps are " +
        "written, pre-existing duplicate test cases are deleted automatically, and a run that changes " +
        "nothing completes in seconds. Refuses to start if another run holds the same story's lock.\n" +
        "Recommended flow: this tool previews by default, so call it as-is first to " +
        "review the plan, then call it again with dryRun=false to apply.",
      inputSchema: z.object({
        storyKey: z.string().optional().describe("Story key; defaults to JIRA_STORY_KEY in .env"),
        dryRun: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Preview only and make no changes. This is the DEFAULT. Pass dryRun=false to write to Jira and AgileTest.",
          ),
        concurrency: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(8)
          .describe("Parallel requests (default 8)"),
        verify: z
          .boolean()
          .optional()
          .default(true)
          .describe("Verify the final state against the CSV after the run"),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const storyKey = requireStoryKey(input);
        if (!process.env.JIRA_PROJECT_KEY) throw new Error("JIRA_PROJECT_KEY must be set in .env.");
        if (!process.env.AGILETEST_PROJECT_ID) {
          throw new Error("AGILETEST_PROJECT_ID must be set in .env.");
        }

        return await runPipeline({
          storyKey,
          projectId: process.env.AGILETEST_PROJECT_ID,
          jiraProjectKey: process.env.JIRA_PROJECT_KEY,
          assigneeAccountId: process.env.JIRA_ASSIGNEE_ACCOUNT_ID,
          dryRun: input?.dryRun ?? true,
          concurrency: input?.concurrency ?? 5,
          verify: input?.verify ?? true,
          log: (m) => console.log(m),
        });
      },
    });

    // Tool: read-only health check for a story
    server.tool("audit_story", {
      description:
        "Read-only audit of a story: reports duplicate test cases, test cases missing from the " +
        "generated CSV, test cases whose step count does not match the CSV, and whether a run " +
        "is currently locked. Makes no changes.",
        inputSchema: z.object({
          storyKey: z.string().optional().describe("Story key; defaults to JIRA_STORY_KEY in .env"),
        }),
        outputSchema: z.any(),
        async handler(input) {
          const stale = checkStaleCode();
          const storyKey = requireStoryKey(input);
          if (!process.env.AGILETEST_PROJECT_ID) {
            throw new Error("AGILETEST_PROJECT_ID must be set in .env.");
          }
          const result = await verifyStory({
            storyKey,
            projectId: process.env.AGILETEST_PROJECT_ID,
            log: (m) => console.log(m),
          });
          return {
            storyKey,
            // Surfaces staleness on a read-only call, so it can be seen without
            // attempting a run that would be refused.
            build: { ...getBuildInfo(), stale },
            ...result,
            lock: inspectLock(storyKey),
          };
        },
      });

    // Tool: remove duplicate test cases from a story
    server.tool("dedupe_story", {
      description:
        "Remove duplicate Jira test cases from a story, keeping one per summary. " +
        "Only issues of the configured Test Case type that are currently linked to the story are " +
        "considered, and one survivor is always kept. Defaults to a dry run; pass dryRun=false to delete.",
      inputSchema: z.object({
        storyKey: z.string().optional().describe("Story key; defaults to JIRA_STORY_KEY in .env"),
        dryRun: z
          .boolean()
          .optional()
          .default(true)
          .describe("Report what would be deleted without deleting (default true)"),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const storyKey = requireStoryKey(input);
        const result = await dedupeStory({
          storyKey,
          dryRun: input?.dryRun ?? true,
          log: (m) => console.log(m),
        });
        return { ...result, durationLabel: formatDuration(result.durationMs) };
      },
    });

    // Tool: Jira phase only
    server.tool("jira_run_csv_from_env_story", {
      description:
        "Jira phase only: create/reuse Jira TestCases and write Execution_Results/<STORY>_testcases_results.csv. Idempotent by summary.",
      inputSchema: z.object({
        storyKey: z.string().optional(),
          dryRun: z
            .boolean()
            .optional()
            .default(true)
            .describe("Preview only; make no changes. Pass false to write. Default is true."),
        concurrency: z.number().int().min(1).max(20).optional().default(8),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const storyKey = requireStoryKey(input);
        if (!process.env.JIRA_PROJECT_KEY) throw new Error("JIRA_PROJECT_KEY must be set in .env.");

        const result = await runJiraPhase({
          storyKey,
          jiraProjectKey: process.env.JIRA_PROJECT_KEY,
          assigneeAccountId: process.env.JIRA_ASSIGNEE_ACCOUNT_ID,
          dryRun: input?.dryRun ?? true,
          concurrency: input?.concurrency ?? 5,
          log: (m) => console.log(m),
        });

        return {
          storyKey,
          dryRun: result.dryRun,
          createdCount: result.createdCount ?? 0,
          reusedCount: result.reusedCount ?? 0,
          preExistingDuplicates: result.preExistingDuplicates || [],
          resultsCsvPath: path.join("Execution_Results", `${storyKey}_testcases_results.csv`),
          durationLabel: formatDuration(result.durationMs),
        };
      },
    });

    // Tool: full pipeline (kept for backwards compatibility with the old tool name)
    server.tool("jira_agiletest_run_from_env_story", {
      description:
        "Backwards-compatible alias for push_test_cases. Safe to re-run; prefer push_test_cases.",
      inputSchema: z.object({
        storyKey: z.string().optional(),
          dryRun: z
            .boolean()
            .optional()
            .default(true)
            .describe("Preview only; make no changes. Pass false to write. Default is true."),
        concurrency: z.number().int().min(1).max(20).optional().default(8),
        verify: z.boolean().optional().default(true),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const storyKey = requireStoryKey(input);
        if (!process.env.JIRA_PROJECT_KEY) throw new Error("JIRA_PROJECT_KEY must be set in .env.");
        if (!process.env.AGILETEST_PROJECT_ID) {
          throw new Error("AGILETEST_PROJECT_ID must be set in .env.");
        }
        return await runPipeline({
          storyKey,
          projectId: process.env.AGILETEST_PROJECT_ID,
          jiraProjectKey: process.env.JIRA_PROJECT_KEY,
          assigneeAccountId: process.env.JIRA_ASSIGNEE_ACCOUNT_ID,
          dryRun: input?.dryRun ?? true,
          concurrency: input?.concurrency ?? 5,
          verify: input?.verify ?? true,
          log: (m) => console.log(m),
        });
      },
    });
  }
}
