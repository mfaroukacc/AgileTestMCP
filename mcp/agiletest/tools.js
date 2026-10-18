import { z } from "zod";
import {
  getAgileTestJwt,
  createAgileTestTestCasesFromIssueIds,
  getAgileTestTestcasesByJiraIssueIds,
  createAgileTestTestStep,
  createAgileTestPrecondition,
  createAgileTestExecution,
  getAgileTestExecutionsByJiraIssueIds,
  getAgileTestExecutionTestCases,
  linkAgileTestTestCasesToExecution,
  createAgileTestTestPlan,
  getAgileTestTestPlansByJiraIssueIds,
  linkAgileTestTestCasesToTestPlan,
  linkAgileTestTestPlanToExecutions,
} from "../../src/core/agiletestClient.js";
import { getJiraIssuesBulk } from "../../src/core/jiraClient.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runAgileTestPhase } from "../../src/core/pipeline/agileTestPhase.js";
import { formatDuration } from "../../src/core/pipeline/concurrency.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");

function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];

  const header = lines[0].split(",");
  const rows = lines.slice(1);

  return rows.map((line) => {
    const cols = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "\"") {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        cols.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    cols.push(current);

    const obj = {};
    header.forEach((h, idx) => {
      obj[h.trim()] = cols[idx]?.replace(/^\"|\"$/g, "") ?? "";
    });
    return obj;
  });
}

function serializeResultsRow(row) {
  const values = [
    row.test_case_name,
    row.priority,
    row.jira_issue_key,
    row.jira_issue_id != null ? String(row.jira_issue_id) : "",
    row.agiletest_testcase_id != null ? String(row.agiletest_testcase_id) : "",
  ].map((value) => {
    const str = value == null ? "" : String(value);
    if (str.includes("\"") || str.includes(",") || str.includes("\n")) {
      return `"${str.replace(/\"/g, "\"\"")}"`;
    }
    return str;
  });

  return values.join(",");
}

async function resolveAgileTestCase(jwt, projectId, jiraIssueId) {
  const waitMs = 10000; // 10 seconds
  const totalMinutes = 2;
  const attemptsPerMinute = 6; // 60s / 10s
  const maxAttempts = totalMinutes * attemptsPerMinute; // 12 attempts

  let agileTestCase = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      console.log(
        `Attempt ${attempt}/${maxAttempts}: resolving AgileTest test case for Jira issue id`,
        jiraIssueId,
      );

      const testCases = await getAgileTestTestcasesByJiraIssueIds(jwt, {
        projectId,
        jiraIssueIds: [Number(jiraIssueId)],
        expand: [],
      });

      if (Array.isArray(testCases) && testCases.length > 0) {
        console.log(
          "DEBUG: /ds/test-cases/issue/bulk returned",
          testCases.length,
          "test case(s).",
        );
        agileTestCase = testCases[0];
        break;
      }

      if (attempt === maxAttempts) {
        break;
      }

      console.log(
        `AgileTest test case not found yet for Jira issue id ${jiraIssueId}. ` +
          `Waiting ${waitMs / 1000} seconds before retry...`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    } catch (e) {
      const msg = e?.message || e?.response?.data || e;
      const isNotFound =
        typeof msg === "string" && msg.includes("No AgileTest test cases found");

      if (!isNotFound || attempt === maxAttempts) {
        throw e;
      }

      console.log(
        `AgileTest test case not found yet for Jira issue id ${jiraIssueId}. ` +
          `Waiting ${waitMs / 1000} seconds before retry...`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  return agileTestCase;
}

// AgileTest is optional per call: every new tool takes projectId explicitly but
// falls back to AGILETEST_PROJECT_ID from .env, so a caller never has to repeat
// a value that is already configured.
function resolveProjectId(input) {
  const projectId = String(input?.projectId || process.env.AGILETEST_PROJECT_ID || "").trim();
  if (!projectId) {
    throw new Error(
      "AgileTest project id is required: pass projectId or set AGILETEST_PROJECT_ID in .env.",
    );
  }
  return projectId;
}

// Every tool that writes to AgileTest previews first, matching the pipeline
// tools: an accidental call with no arguments changes nothing.
const dryRunSchema = z
  .boolean()
  .optional()
  .default(true)
  .describe("Preview only; make no changes. Pass dryRun=false to write. Default is true.");

function dryRunPreview(projectId, action, details = {}) {
  return {
    dryRun: true,
    projectId,
    plannedAction: action,
    ...details,
    note: "Nothing was sent to AgileTest. Call again with dryRun=false to apply.",
  };
}

const JIRA_ISSUE_IDS = z
  .array(z.union([z.string(), z.number()]))
  .min(1)
  .describe("Numeric Jira issue IDs (not issue keys), e.g. [17576]");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// /ds/test-executions/{id}/test-cases returns testExecutionItems as a single
// object when a case has one result row and as an array when it has several.
function executionItemsOf(testCase) {
  const raw = testCase?.testExecutionItems;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  return [];
}

// List inputs are optional in the schema on purpose: the verify script proves
// that omitting every argument still resolves dryRun=true, so emptiness is
// enforced here instead, where the caller gets a named error.
function requireIds(value, name) {
  const list = (Array.isArray(value) ? value : [])
    .map((v) => String(v ?? "").trim())
    .filter(Boolean);
  if (!list.length) {
    throw new Error(`${name} must contain at least one numeric id.`);
  }
  return list;
}

const isoDate = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// The link/list tools are keyed by the AgileTest entity id, but callers usually
// only hold the Jira issue id that produced it, so both are accepted everywhere.
async function resolveAgileTestExecutionId(jwt, projectId, { testExecutionId, jiraTestExecutionIssueId }) {
  if (testExecutionId != null && String(testExecutionId).trim()) {
    return String(testExecutionId).trim();
  }
  if (jiraTestExecutionIssueId == null || !String(jiraTestExecutionIssueId).trim()) {
    throw new Error(
      "Provide testExecutionId (AgileTest execution id) or jiraTestExecutionIssueId (numeric Jira Test Execution issue id).",
    );
  }

  const executions = await getAgileTestExecutionsByJiraIssueIds(jwt, {
    projectId,
    testExecutionIssueIds: [String(jiraTestExecutionIssueId).trim()],
  });

  const execution = executions[0];
  if (!execution?.id) {
    throw new Error(
      `No AgileTest Test Execution found for Jira issue id ${jiraTestExecutionIssueId}. ` +
        "Create it first with agiletest_create_test_execution.",
    );
  }
  return String(execution.id);
}

async function resolveAgileTestPlanId(jwt, projectId, { testPlanId, jiraTestPlanIssueId }) {
  if (testPlanId != null && String(testPlanId).trim()) {
    return String(testPlanId).trim();
  }
  if (jiraTestPlanIssueId == null || !String(jiraTestPlanIssueId).trim()) {
    throw new Error(
      "Provide testPlanId (AgileTest plan id) or jiraTestPlanIssueId (numeric Jira Test Plan issue id).",
    );
  }

  const plans = await getAgileTestTestPlansByJiraIssueIds(jwt, {
    projectId,
    testPlanIssueIds: [String(jiraTestPlanIssueId).trim()],
  });

  const plan = plans[0];
  if (!plan?.id) {
    throw new Error(
      `No AgileTest Test Plan found for Jira issue id ${jiraTestPlanIssueId}. ` +
        "Create it first with agiletest_create_test_plan.",
    );
  }
  return String(plan.id);
}

const ID_INPUTS = {
  testExecutionId: z
    .union([z.string(), z.number()])
    .optional()
    .describe("AgileTest Test Execution id (from agiletest_create_test_execution)."),
  jiraTestExecutionIssueId: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Numeric Jira Test Execution issue id; used to resolve the AgileTest execution id when testExecutionId is omitted."),
  testPlanId: z
    .union([z.string(), z.number()])
    .optional()
    .describe("AgileTest Test Plan id (from agiletest_create_test_plan)."),
  jiraTestPlanIssueId: z
    .union([z.string(), z.number()])
    .optional()
    .describe("Numeric Jira Test Plan issue id; used to resolve the AgileTest plan id when testPlanId is omitted."),
};

// AgileTest test execution result status ids (instance-specific, see readme.txt).
const RESULT_STATUS = {
  pass: 28912,
  fail: 28913,
  blocked: 28914,
  query: 28915,
  skipped: 28916,
  retest: 28917,
};

// Result status id -> human label, for readable summaries.
const RESULT_STATUS_LABELS = Object.fromEntries(
  Object.entries(RESULT_STATUS).map(([label, id]) => [String(id), label]),
);

export class AgileTestTools {
  static register(server) {
    // Tool: authenticate and return JWT (mainly for debugging)
    // Tool: authenticate and return JWT using env-configured client id/secret.
    // No input is required because AGILETEST_CLIENT_ID and AGILETEST_CLIENT_SECRET are read
    // from the server process environment (.env). This is useful mainly for diagnostics.
    server.tool("agiletest_get_jwt", {
      description:
        "Get an AgileTest JWT using AGILETEST_CLIENT_ID/SECRET from environment (no input needed).",
      inputSchema: z.object({}),
      outputSchema: z.object({ token: z.string() }),
      async handler() {
        const token = await getAgileTestJwt();
        return { token };
      },
    });

    // Tool: create AgileTest test cases from Jira issue IDs
    server.tool("agiletest_create_testcases_from_issue_ids", {
      description: "Create AgileTest test cases from Jira TestCase issue IDs via /ds/test-cases/bulk.",
      inputSchema: z.object({
        projectId: z.string().describe("AgileTest project id"),
        folderId: z.number().int().optional().default(0),
        jiraIssueIds: z.array(z.union([z.string(), z.number()])).describe("Array of Jira issue numeric IDs"),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const jwt = await getAgileTestJwt();
        const result = await createAgileTestTestCasesFromIssueIds(jwt, {
          projectId: input.projectId,
          folderId: input.folderId ?? 0,
          testCaseIssueIds: input.jiraIssueIds,
        });
        return result;
      },
    });

    // Tool: lookup AgileTest test cases by Jira issue IDs
    server.tool("agiletest_get_testcases_by_issue_ids", {
      description: "Lookup AgileTest test cases mapped from Jira issue IDs.",
      inputSchema: z.object({
        projectId: z.string().describe("AgileTest project id"),
        jiraIssueIds: z.array(z.union([z.string(), z.number()])).describe("Array of Jira issue numeric IDs"),
        expand: z.array(z.string()).optional(),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const jwt = await getAgileTestJwt();
        const result = await getAgileTestTestcasesByJiraIssueIds(jwt, {
          projectId: input.projectId,
          jiraIssueIds: input.jiraIssueIds,
          expand: input.expand ?? [],
        });
        return result;
      },
    });

    // Tool: create AgileTest test step
    server.tool("agiletest_create_test_step", {
      description: "Create a single AgileTest test step for a given test case.",
      inputSchema: z.object({
        projectId: z.string(),
        testCaseId: z.union([z.string(), z.number()]),
        action: z.string(),
        expectedResult: z.string(),
        data: z.string().optional().default(""),
        stepIndex: z.number().int().optional().default(0),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const jwt = await getAgileTestJwt();
        const result = await createAgileTestTestStep(jwt, {
          projectId: input.projectId,
          testCaseId: input.testCaseId,
          action: input.action,
          expectedResult: input.expectedResult,
          dataField: input.data ?? "",
          stepIndex: input.stepIndex ?? 0,
        });
        return result;
      },
    });

    // Tool: create / update AgileTest precondition
    server.tool("agiletest_set_precondition", {
      description: "Create or update an AgileTest precondition for a test case.",
      inputSchema: z.object({
        testCaseId: z.union([z.string(), z.number()]),
        body: z.record(z.any()).describe("Raw AgileTest precondition payload"),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const jwt = await getAgileTestJwt();
        const result = await createAgileTestPrecondition(jwt, {
          testCaseId: input.testCaseId,
          body: input.body,
        });
        return result;
      },
    });

    // Tool: create AgileTest test cases, preconditions and steps from Jira issue IDs and CSVs
    server.tool("agiletest_process_from_issue_ids_and_csv", {
      description:
        "For each Jira TestCase issue id, create/ensure an AgileTest test case via /ds/test-cases/bulk, then create/update preconditions and test steps from a generated CSV, and finally update the results CSV with agiletest_testcase_id.",
      inputSchema: z.object({
        projectId: z.string().describe("AgileTest project id"),
        folderId: z.number().int().optional().default(0),
        jiraIssueIds: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .describe("Array of Jira TestCase numeric IDs to process"),
        generatedCsvPath: z
          .string()
          .describe(
            "Relative or absolute path from project root to generated test cases CSV (e.g. 'Generated_Test_Cases/Signals/CIR-10_testcases_generated.csv')",
          ),
        resultsCsvPath: z
          .string()
          .describe(
            "Relative or absolute path from project root to results CSV (e.g. 'Execution_Results/CIR-10_testcases_results.csv')",
          ),
      }),
      outputSchema: z.object({
        projectId: z.string(),
        processedJiraIssueIds: z.array(z.string()),
        resultsCsvPath: z.string(),
        resultsCsvContent: z.string(),
      }),
      async handler(input) {
        const jwt = await getAgileTestJwt();
        const projectId = input.projectId;
        const folderId = input.folderId ?? 0;

        const absGeneratedPath = path.isAbsolute(input.generatedCsvPath)
          ? input.generatedCsvPath
          : path.join(PROJECT_ROOT, input.generatedCsvPath);
        const absResultsPath = path.isAbsolute(input.resultsCsvPath)
          ? input.resultsCsvPath
          : path.join(PROJECT_ROOT, input.resultsCsvPath);

        if (!fs.existsSync(absGeneratedPath)) {
          throw new Error(`Generated test cases CSV not found at ${absGeneratedPath}`);
        }

        if (!fs.existsSync(absResultsPath)) {
          throw new Error(`Results CSV not found at ${absResultsPath}`);
        }

        const resultsRows = parseCsv(absResultsPath);
        const generatedRows = parseCsv(absGeneratedPath);

        if (!resultsRows.length) {
          throw new Error("No rows found in results CSV.");
        }

        if (!generatedRows.length) {
          throw new Error("No rows found in generated test cases CSV.");
        }

        const idSet = new Set(
          input.jiraIssueIds.map((id) => String(id).trim()).filter((v) => v),
        );

        const processedIds = [];

        for (const resultRow of resultsRows) {
          const jiraIssueIdRaw = resultRow.jira_issue_id ?? resultRow.jiraIssueId;
          const jiraIssueId = String(jiraIssueIdRaw || "").trim();
          const testCaseName = (resultRow.test_case_name || "").trim();

          if (!jiraIssueId || !testCaseName) {
            continue;
          }

          if (!idSet.has(jiraIssueId)) {
            continue;
          }

          console.log("----------------------------------------");
          console.log(
            "Processing Jira issue id",
            jiraIssueId,
            "for test case",
            testCaseName,
          );

          const rowsForTestCase = generatedRows.filter(
            (r) => (r.test_case_name || "").trim() === testCaseName,
          );
          if (!rowsForTestCase.length) {
            console.warn(
              "No rows found in generated CSV for test_case_name",
              testCaseName,
              "- skipping.",
            );
            continue;
          }

          // 1) Create AgileTest test case via /ds/test-cases/bulk for this Jira id
          try {
            console.log(
              "Creating AgileTest test case via /ds/test-cases/bulk for Jira issue id",
              jiraIssueId,
            );
            const createResponse = await createAgileTestTestCasesFromIssueIds(jwt, {
              projectId,
              folderId,
              testCaseIssueIds: [Number(jiraIssueId)],
            });
            console.log(
              "SUCCESS: AgileTest bulk create response:",
              JSON.stringify(createResponse, null, 2),
            );
          } catch (createErr) {
            console.error(
              "ERROR: Failed to create AgileTest test case via /ds/test-cases/bulk:",
              createErr.response?.data || createErr.message || createErr,
            );
          }

          // 2) Resolve AgileTest test case for this Jira id (with retry)
          const agileTestCase = await resolveAgileTestCase(jwt, projectId, jiraIssueId);

          if (!agileTestCase) {
            console.error(
              "ERROR: Could not resolve AgileTest test case for Jira issue id",
              jiraIssueId,
              "- skipping.",
            );
            continue;
          }

          console.log(
            "DEBUG: AgileTest test case object:",
            JSON.stringify(agileTestCase, null, 2),
          );
          const testCaseId = agileTestCase.id;
          console.log(
            "SUCCESS: AgileTest test case resolved for Jira issue id",
            jiraIssueId,
          );
          console.log("SUCCESS: AgileTest testCaseId:", testCaseId);

          // 3) Create precondition from CSV (if provided)
          const preconditionText = (rowsForTestCase[0]?.precondition || "").trim();
          if (preconditionText) {
            try {
              console.log(
                "Creating AgileTest precondition for",
                testCaseName,
                "-> testCaseId",
                testCaseId,
              );
              const preconditionPayload = {
                precondition: {
                  title: "Precondition",
                  details: preconditionText,
                },
                projectId,
              };

              const preconditionResponse = await createAgileTestPrecondition(jwt, {
                testCaseId,
                body: preconditionPayload,
              });
              console.log(
                "SUCCESS: Precondition created/updated for test case",
                testCaseName,
              );
              console.log(JSON.stringify(preconditionResponse, null, 2));
            } catch (preconditionErr) {
              console.warn(
                "WARNING: Failed to create AgileTest precondition for test case",
                testCaseName,
                ":",
                preconditionErr.response?.data ||
                  preconditionErr.message ||
                  preconditionErr,
              );
            }
          } else {
            console.log(
              "No precondition specified in CSV for test case",
              testCaseName,
              "- skipping precondition creation.",
            );
          }

          // 4) Create AgileTest test steps from CSV rows
          console.log(
            "Creating AgileTest test steps for",
            testCaseName,
            "-> testCaseId",
            testCaseId,
          );

          const sortedRows = [...rowsForTestCase].sort((a, b) => {
            const aNum = Number(a.step_number ?? a.stepNumber ?? 0);
            const bNum = Number(b.step_number ?? b.stepNumber ?? 0);
            return aNum - bNum;
          });

          for (const row of sortedRows) {
            const stepNumberRaw = row.step_number ?? row.stepNumber;
            const stepNumber = Number(stepNumberRaw);
            if (!stepNumber || Number.isNaN(stepNumber)) {
              console.warn(
                "Skipping row with invalid step_number for test case",
                testCaseName,
                "row:",
                row,
              );
              continue;
            }

            const rawAction = row.action || "";
            const rawExpectedResult =
              row.expected_result ?? row.expectedResult ?? "";

            const action = rawAction ? `<p>${rawAction}</p>` : "";
            const expectedResult = rawExpectedResult
              ? `<p>${rawExpectedResult}</p>`
              : "";

            if (!action && !expectedResult) {
              console.warn(
                "Skipping row with empty action and expected_result for test case",
                testCaseName,
              );
              continue;
            }

            const createdStep = await createAgileTestTestStep(jwt, {
              projectId,
              testCaseId,
              action,
              expectedResult,
              stepIndex: stepNumber - 1,
            });
            console.log(
              `SUCCESS: created AgileTest step ${stepNumber} with id:`,
              createdStep.id,
            );
          }

          // 5) Update in-memory results row with AgileTest testCaseId
          resultRow.agiletest_testcase_id = testCaseId;

          console.log(
            "SUCCESS: Finished creating AgileTest precondition and steps for Jira issue id",
            jiraIssueId,
          );

          processedIds.push(jiraIssueId);
        }

        // 6) Persist updated results CSV
        const header =
          "test_case_name,priority,jira_issue_key,jira_issue_id,agiletest_testcase_id";
        const outLines = [
          header,
          ...resultsRows.map((row) => serializeResultsRow(row)),
        ];
        fs.writeFileSync(absResultsPath, outLines.join("\n"), "utf8");
        console.log(
          "SUCCESS: Updated results CSV with AgileTest testCaseId values for all processed rows.",
        );

        const resultsCsvContent = fs.readFileSync(absResultsPath, "utf8");

        return {
          projectId,
          processedJiraIssueIds: processedIds,
          resultsCsvPath: path.relative(PROJECT_ROOT, absResultsPath),
          resultsCsvContent,
        };
      },
    });

    // Tool: AgileTest phase only - idempotent, writes only missing steps
    server.tool("agiletest_run_csv_from_env_story", {
      description:
        "AgileTest phase only: create/reuse AgileTest test cases, add preconditions, and add only " +
        "missing test steps from the generated CSV, then update Execution_Results/<STORY>_testcases_results.csv " +
        "with agiletest_testcase_id. Safe to re-run: existing steps are matched and not duplicated. " +
        "Requires the Jira phase to have run first (results CSV must contain jira_issue_id).",
      inputSchema: z.object({
        storyKey: z.string().optional().describe("Story key; defaults to JIRA_STORY_KEY in .env"),
          dryRun: z
            .boolean()
            .optional()
            .default(true)
            .describe("Preview only; make no changes. Pass false to write. Default is true."),
        concurrency: z.number().int().min(1).max(20).optional().default(5),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const storyKey = (input?.storyKey || process.env.JIRA_STORY_KEY || "").trim();
        if (!storyKey) {
          throw new Error(
            "JIRA_STORY_KEY must be set in environment (.env) or passed as input.storyKey.",
          );
        }
        if (!process.env.AGILETEST_PROJECT_ID) {
          throw new Error("AGILETEST_PROJECT_ID must be set in .env.");
        }

        const result = await runAgileTestPhase({
          storyKey,
          projectId: process.env.AGILETEST_PROJECT_ID,
          dryRun: input?.dryRun ?? true,
          concurrency: input?.concurrency ?? 5,
          log: (m) => console.log(m),
        });

        return {
          storyKey,
          dryRun: result.dryRun,
          createdTestCases: result.createdCount ?? 0,
          reusedTestCases: result.reusedCount ?? 0,
          createdSteps: result.createdSteps ?? 0,
          rebuiltTestCases: result.rebuilt ?? 0,
          unchangedTestCases: result.unchanged ?? 0,
          preconditionSet: result.preconditionSet ?? 0,
          preconditionUpdated: result.preconditionUpdated ?? 0,
          preconditionFailed: result.preconditionFailed ?? 0,
          preconditionErrors: result.preconditionErrors || [],
          resultsCsvPath: path.join("Execution_Results", `${storyKey}_testcases_results.csv`),
          durationLabel: formatDuration(result.durationMs),
        };
      },
    });

    // ------------------------------------------------------------------
    // Test executions
    // ------------------------------------------------------------------

    // Tool: create an AgileTest Test Execution from Jira Test Execution issues
    server.tool("agiletest_create_test_execution", {
      title: "Create AgileTest Test Execution",
      description:
        "Create AgileTest Test Execution(s) from numeric Jira Test Execution issue ID(s) and return the AgileTest " +
        "execution id(s) needed by every other execution tool. Two calls are made: POST /ds/test-executions creates " +
        "the execution(s), then POST /ds/test-executions/issue/bulk resolves the AgileTest ids (the create response " +
        "does not reliably carry them). Use this once a Jira Test Execution issue exists - it is the AgileTest " +
        "counterpart of that Jira issue, not a new Jira issue. Typical setup order: create_test_execution -> " +
        "agiletest_link_testcases_to_execution -> execute tests. Previews by default; pass dryRun=false to create.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testExecutionIssueIds: JIRA_ISSUE_IDS.optional().describe(
          "Numeric Jira Test Execution issue IDs (e.g. Data.json JIRA_TESTEXEC_ISSUE_ID), not keys. " +
            "Required when dryRun=false.",
        ),
        dryRun: dryRunSchema,
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const testExecutionIssueIds = requireIds(input.testExecutionIssueIds, "testExecutionIssueIds");

        if (input.dryRun !== false) {
          return dryRunPreview(
            projectId,
            "POST /ds/test-executions then POST /ds/test-executions/issue/bulk",
            { testExecutionIssueIds },
          );
        }

        const jwt = await getAgileTestJwt();
        const created = await createAgileTestExecution(jwt, { projectId, testExecutionIssueIds });
        const executions = await getAgileTestExecutionsByJiraIssueIds(jwt, {
          projectId,
          testExecutionIssueIds,
        });

        return {
          dryRun: false,
          projectId,
          created,
          executions,
          testExecutionIds: executions.map((e) => String(e?.id ?? "")),
        };
      },
    });

    // Tool: resolve AgileTest Test Executions from Jira Test Execution issues
    server.tool("agiletest_get_test_executions_by_issue_ids", {
      title: "Get AgileTest Test Executions by Jira issue IDs",
      description:
        "Read-only lookup of existing AgileTest Test Execution(s) by their numeric Jira Test Execution issue ID(s) " +
        "via POST /ds/test-executions/issue/bulk. Use to recover the AgileTest execution id for an execution that " +
        "was created earlier (it is not stored anywhere except Data.json in the legacy scripts), or to confirm an " +
        "execution exists before linking test cases to it. Never creates anything.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testExecutionIssueIds: JIRA_ISSUE_IDS.describe("Numeric Jira Test Execution issue IDs."),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const testExecutionIssueIds = input.testExecutionIssueIds.map(String);
        const jwt = await getAgileTestJwt();
        const executions = await getAgileTestExecutionsByJiraIssueIds(jwt, {
          projectId,
          testExecutionIssueIds,
        });

        return {
          projectId,
          testExecutionIssueIds,
          count: executions.length,
          executions,
          testExecutionIds: executions.map((e) => String(e?.id ?? "")),
        };
      },
    });

    // Tool: list the test cases (and their results) of an execution
    server.tool("agiletest_get_testcases_for_execution", {
      title: "Get Test Cases for an AgileTest Execution",
      description:
        "Read-only list of the AgileTest test cases linked to an AgileTest Test Execution via " +
        "GET /ds/test-executions/{id}/test-cases, including each case's testExecutionItems with the recorded " +
        "result status ids (28912 pass, 28913 fail, 28914 blocked, 28915 query, 28916 skipped, 28917 retest). " +
        "Accepts either the AgileTest execution id or the numeric Jira Test Execution issue id (resolved through " +
        "the bulk lookup). Use to inspect what ran and how it ended; use agiletest_export_failed_testcases for a " +
        "failures-only view with Jira keys.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testExecutionId: ID_INPUTS.testExecutionId,
        jiraTestExecutionIssueId: ID_INPUTS.jiraTestExecutionIssueId,
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const jwt = await getAgileTestJwt();
        const testExecutionId = await resolveAgileTestExecutionId(jwt, projectId, input);

        const items = await getAgileTestExecutionTestCases(jwt, { projectId, testExecutionId });

        const testCases = items.map((tc) => {
          const executionItems = executionItemsOf(tc);
          const resultIds = executionItems
            .map((item) => String(item?.result ?? ""))
            .filter((id) => id && id !== "null" && id !== "undefined");

          return {
            agileTestTestCaseId: tc?.id ?? null,
            jiraIssueId: tc?.issueId ?? tc?.jiraIssueId ?? tc?.jira?.issueId ?? null,
            resultIds,
            results: resultIds.map((id) => RESULT_STATUS_LABELS[id] || id),
            failed: resultIds.includes(String(RESULT_STATUS.fail)),
          };
        });

        return {
          projectId,
          testExecutionId,
          count: testCases.length,
          failedCount: testCases.filter((tc) => tc.failed).length,
          testCases,
          items,
        };
      },
    });

    // Tool: link test cases to an execution
    server.tool("agiletest_link_testcases_to_execution", {
      title: "Link Test Cases to an AgileTest Execution",
      description:
        "Link numeric Jira Test Case issue IDs to an AgileTest Test Execution via " +
        "POST /ds/test-executions/{id}/link/test-cases, so the cases appear in that execution and their results " +
        "are recorded against it. Requires the execution to exist (agiletest_create_test_execution) and the test " +
        "cases to already exist as AgileTest test cases (agiletest_create_testcases_from_issue_ids). " +
        "The execution may be given as the AgileTest id or as the numeric Jira Test Execution issue id. " +
        "Previews by default; pass dryRun=false to link.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testExecutionId: ID_INPUTS.testExecutionId,
        jiraTestExecutionIssueId: ID_INPUTS.jiraTestExecutionIssueId,
        testCaseIssueIds: JIRA_ISSUE_IDS.optional().describe(
          "Numeric Jira Test Case issue IDs to link into the execution. Required when dryRun=false.",
        ),
        dryRun: dryRunSchema,
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const testCaseIssueIds = requireIds(input.testCaseIssueIds, "testCaseIssueIds");

        if (input.dryRun !== false) {
          return dryRunPreview(
            projectId,
            "POST /ds/test-executions/{id}/link/test-cases",
            {
              testExecutionId: input.testExecutionId ?? null,
              jiraTestExecutionIssueId: input.jiraTestExecutionIssueId ?? null,
              testCaseIssueIds,
            },
          );
        }

        const jwt = await getAgileTestJwt();
        const testExecutionId = await resolveAgileTestExecutionId(jwt, projectId, input);
        const result = await linkAgileTestTestCasesToExecution(jwt, {
          projectId,
          testExecutionId,
          testCaseIssueIds,
        });

        return {
          dryRun: false,
          projectId,
          testExecutionId,
          testCaseIssueIds,
          linkedCount: testCaseIssueIds.length,
          result,
        };
      },
    });

    // ------------------------------------------------------------------
    // Test plans
    // ------------------------------------------------------------------

    // Tool: create an AgileTest Test Plan from Jira Test Plan issues
    server.tool("agiletest_create_test_plan", {
      title: "Create AgileTest Test Plan",
      description:
        "Create AgileTest Test Plan(s) from numeric Jira Test Plan issue ID(s) over a start/end date range and " +
        "return the AgileTest plan id(s). Two calls are made: POST /ds/test-plans creates the plan(s), then " +
        "POST /ds/test-plans/issue/bulk resolves the AgileTest ids. Dates are YYYY-MM-DD and default to today / " +
        "today+3 days when omitted. Use once a Jira Test Plan issue exists; afterwards assign executions and cases " +
        "to it with agiletest_link_test_plan_to_executions and agiletest_link_testcases_to_test_plan. " +
        "Previews by default; pass dryRun=false to create.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testPlanIssueIds: JIRA_ISSUE_IDS.optional().describe(
          "Numeric Jira Test Plan issue IDs (Data.json JIRA_TESTPLAN_ISSUE_ID). Required when dryRun=false.",
        ),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
          .optional()
          .describe("Plan start date, YYYY-MM-DD. Defaults to today."),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD")
          .optional()
          .describe("Plan end date, YYYY-MM-DD. Defaults to today + 3 days."),
        dryRun: dryRunSchema,
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const testPlanIssueIds = requireIds(input.testPlanIssueIds, "testPlanIssueIds");
        const startDate = input.startDate || isoDate();
        const endDate = input.endDate || isoDate(Date.now() + 3 * 24 * 60 * 60 * 1000);

        if (input.dryRun !== false) {
          return dryRunPreview(projectId, "POST /ds/test-plans then POST /ds/test-plans/issue/bulk", {
            testPlanIssueIds,
            startDate,
            endDate,
          });
        }

        const jwt = await getAgileTestJwt();
        const created = await createAgileTestTestPlan(jwt, {
          projectId,
          testPlanIssueIds,
          startDate,
          endDate,
        });
        const testPlans = await getAgileTestTestPlansByJiraIssueIds(jwt, {
          projectId,
          testPlanIssueIds,
        });

        return {
          dryRun: false,
          projectId,
          startDate,
          endDate,
          created,
          testPlans,
          testPlanIds: testPlans.map((p) => String(p?.id ?? "")),
        };
      },
    });

    // Tool: resolve AgileTest Test Plans from Jira Test Plan issues
    server.tool("agiletest_get_test_plans_by_issue_ids", {
      title: "Get AgileTest Test Plans by Jira issue IDs",
      description:
        "Read-only lookup of existing AgileTest Test Plan(s) by their numeric Jira Test Plan issue ID(s) via " +
        "POST /ds/test-plans/issue/bulk. Use to recover the AgileTest plan id needed by the link tools, or to " +
        "confirm a plan exists before assigning a test execution to it. Never creates anything.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testPlanIssueIds: JIRA_ISSUE_IDS.describe("Numeric Jira Test Plan issue IDs."),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const testPlanIssueIds = input.testPlanIssueIds.map(String);
        const jwt = await getAgileTestJwt();
        const testPlans = await getAgileTestTestPlansByJiraIssueIds(jwt, { projectId, testPlanIssueIds });

        return {
          projectId,
          testPlanIssueIds,
          count: testPlans.length,
          testPlans,
          testPlanIds: testPlans.map((p) => String(p?.id ?? "")),
        };
      },
    });

    // Tool: assign a test execution to a test plan
    server.tool("agiletest_link_test_plan_to_executions", {
      title: "Assign Test Executions to a Test Plan",
      description:
        "Assign AgileTest Test Execution(s) to an existing AgileTest Test Plan via " +
        "POST /ds/test-plans/{id}/link/test-executions, addressed by numeric Jira Test Execution issue ID(s). " +
        "This is what puts an execution inside a plan. Optionally pass testCaseIssueIds to link the same test " +
        "cases to the plan in the same call (the plan equivalent of POST /ds/test-plans/{id}/link/test-cases), " +
        "which is what the legacy linkTestPlanToExecution script did in two steps. The plan may be given as the " +
        "AgileTest plan id or the numeric Jira Test Plan issue id. " +
        "Previews by default; pass dryRun=false to link.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testPlanId: ID_INPUTS.testPlanId,
        jiraTestPlanIssueId: ID_INPUTS.jiraTestPlanIssueId,
        testExecutionIssueIds: JIRA_ISSUE_IDS.optional().describe(
          "Numeric Jira Test Execution issue IDs to assign to the plan. Required when dryRun=false.",
        ),
        testCaseIssueIds: z
          .array(z.union([z.string(), z.number()]))
          .optional()
          .describe("Optional numeric Jira Test Case issue IDs to link to the plan as well."),
        dryRun: dryRunSchema,
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const testExecutionIssueIds = requireIds(input.testExecutionIssueIds, "testExecutionIssueIds");
        const testCaseIssueIds = (input.testCaseIssueIds || []).map(String);

        if (input.dryRun !== false) {
          return dryRunPreview(
            projectId,
            testCaseIssueIds.length
              ? "POST /ds/test-plans/{id}/link/test-executions then POST /ds/test-plans/{id}/link/test-cases"
              : "POST /ds/test-plans/{id}/link/test-executions",
            {
              testPlanId: input.testPlanId ?? null,
              jiraTestPlanIssueId: input.jiraTestPlanIssueId ?? null,
              testExecutionIssueIds,
              testCaseIssueIds,
            },
          );
        }

        const jwt = await getAgileTestJwt();
        const testPlanId = await resolveAgileTestPlanId(jwt, projectId, input);

        const linkedExecutions = await linkAgileTestTestPlanToExecutions(jwt, {
          projectId,
          testPlanId,
          testExecutionIssueIds,
        });

        let linkedTestCases = null;
        if (testCaseIssueIds.length) {
          linkedTestCases = await linkAgileTestTestCasesToTestPlan(jwt, {
            projectId,
            testPlanId,
            testCaseIssueIds,
          });
        }

        return {
          dryRun: false,
          projectId,
          testPlanId,
          testExecutionIssueIds,
          linkedExecutions,
          testCaseIssueIds,
          linkedTestCases,
        };
      },
    });

    // Tool: link test cases to a plan
    server.tool("agiletest_link_testcases_to_test_plan", {
      title: "Link Test Cases to an AgileTest Test Plan",
      description:
        "Link numeric Jira Test Case issue IDs to an AgileTest Test Plan via " +
        "POST /ds/test-plans/{id}/link/test-cases, so the cases are covered by that plan (reporting, plan " +
        "progress). Requires the plan to exist (agiletest_create_test_plan) and the cases to exist as AgileTest " +
        "test cases. The plan may be given as the AgileTest plan id or the numeric Jira Test Plan issue id. " +
        "Previews by default; pass dryRun=false to link.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testPlanId: ID_INPUTS.testPlanId,
        jiraTestPlanIssueId: ID_INPUTS.jiraTestPlanIssueId,
        testCaseIssueIds: JIRA_ISSUE_IDS.optional().describe(
          "Numeric Jira Test Case issue IDs to link into the plan. Required when dryRun=false.",
        ),
        dryRun: dryRunSchema,
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const testCaseIssueIds = requireIds(input.testCaseIssueIds, "testCaseIssueIds");

        if (input.dryRun !== false) {
          return dryRunPreview(projectId, "POST /ds/test-plans/{id}/link/test-cases", {
            testPlanId: input.testPlanId ?? null,
            jiraTestPlanIssueId: input.jiraTestPlanIssueId ?? null,
            testCaseIssueIds,
          });
        }

        const jwt = await getAgileTestJwt();
        const testPlanId = await resolveAgileTestPlanId(jwt, projectId, input);
        const result = await linkAgileTestTestCasesToTestPlan(jwt, {
          projectId,
          testPlanId,
          testCaseIssueIds,
        });

        return {
          dryRun: false,
          projectId,
          testPlanId,
          testCaseIssueIds,
          linkedCount: testCaseIssueIds.length,
          result,
        };
      },
    });

    // ------------------------------------------------------------------
    // Test case resolution
    // ------------------------------------------------------------------

    // Tool: poll until a Jira issue's AgileTest test case exists
    server.tool("agiletest_resolve_testcase_by_jira_issue_id", {
      title: "Wait for an AgileTest Test Case to Appear",
      description:
        "Read-only poll of POST /ds/test-cases/issue/bulk until the AgileTest test case mapped to a numeric Jira " +
        "issue ID exists, then return it with its AgileTest testCaseId. Use right after creating Jira Test Cases or " +
        "after agiletest_create_testcases_from_issue_ids: the Jira->AgileTest sync is asynchronous, so the mapping " +
        "often does not exist for several seconds and a single lookup fails. This waits instead of failing. " +
        "Nothing is created or changed; it only reads, with a bounded timeout.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        jiraIssueId: z
          .union([z.string(), z.number()])
          .describe("Numeric Jira Test Case issue ID to resolve."),
        maxWaitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .default(120)
          .describe("How long to keep polling before giving up. 0 = single attempt. Default 120."),
        pollIntervalSeconds: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .default(10)
          .describe("Delay between attempts. Default 10."),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const jiraIssueId = String(input.jiraIssueId);
        const maxWaitSeconds = input.maxWaitSeconds ?? 120;
        const pollIntervalSeconds = input.pollIntervalSeconds ?? 10;

        const jwt = await getAgileTestJwt();
        const deadline = Date.now() + maxWaitSeconds * 1000;

        let attempts = 0;
        let lastError = null;

        for (;;) {
          attempts += 1;
          try {
            const testCases = await getAgileTestTestcasesByJiraIssueIds(jwt, {
              projectId,
              jiraIssueIds: [jiraIssueId],
              expand: [],
            });

            if (Array.isArray(testCases) && testCases.length) {
              return {
                found: true,
                attempts,
                projectId,
                jiraIssueId,
                agileTestTestCaseId: testCases[0]?.id ?? null,
                testCase: testCases[0],
              };
            }
            lastError = null;
          } catch (err) {
            lastError = err?.response?.data || err?.message || String(err);
          }

          if (Date.now() + pollIntervalSeconds * 1000 > deadline) break;
          await sleep(pollIntervalSeconds * 1000);
        }

        throw new Error(
          `AgileTest test case for Jira issue id ${jiraIssueId} did not appear within ${maxWaitSeconds}s ` +
            `(${attempts} attempt(s)). ` +
            (lastError ? `Last error: ${typeof lastError === "string" ? lastError : JSON.stringify(lastError)}. ` : "") +
            "Confirm the Jira issue is a Test Case, that it is linked to the story, and that AgileTest has synced it.",
        );
      },
    });

    // ------------------------------------------------------------------
    // Execution reporting
    // ------------------------------------------------------------------

    // Tool: export failed test cases of an execution
    server.tool("agiletest_export_failed_testcases", {
      title: "Export Failed Test Cases from an Execution",
      description:
        "Read-only report of the test cases that FAILED in an AgileTest Test Execution. Reads " +
        "GET /ds/test-executions/{id}/test-cases, keeps every case with any testExecutionItems result equal to " +
        "the failed status id (default 28913), then resolves each Jira issue id to its Jira key in one bulk Jira " +
        "query. Returns structured rows plus the exact markdown table the legacy `npm run agile:export-failed` " +
        "script produced (# | Jira Test Case Issue ID | Jira Test Case Key), so a bug-creation agent can consume " +
        "it directly. Nothing is written unless outputPath is passed; no AgileTest or Jira data is modified.",
      inputSchema: z.object({
        projectId: z
          .string()
          .optional()
          .describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        testExecutionId: ID_INPUTS.testExecutionId,
        jiraTestExecutionIssueId: ID_INPUTS.jiraTestExecutionIssueId,
        failedResultId: z
          .number()
          .int()
          .optional()
          .default(RESULT_STATUS.fail)
          .describe("Result status id treated as failure. Default 28913 (fail)."),
        resolveJiraKeys: z
          .boolean()
          .optional()
          .default(true)
          .describe("Resolve each Jira issue id to its issue key via Jira. Default true; set false to skip Jira."),
        outputPath: z
          .string()
          .optional()
          .describe(
            "Optional path (absolute, or relative to the MCP repo root) to write the markdown, " +
              "e.g. 'Failed_Test_Cases.md'. Omit to return the markdown without touching disk.",
          ),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const projectId = resolveProjectId(input);
        const failedResultId = input.failedResultId ?? RESULT_STATUS.fail;

        const jwt = await getAgileTestJwt();
        const testExecutionId = await resolveAgileTestExecutionId(jwt, projectId, input);

        const items = await getAgileTestExecutionTestCases(jwt, { projectId, testExecutionId });

        const failed = items.filter((tc) =>
          executionItemsOf(tc).some((item) => Number(item?.result) === Number(failedResultId)),
        );

        const jiraIssueIds = failed
          .map((tc) => tc?.issueId ?? tc?.jiraIssueId ?? tc?.jira?.issueId)
          .filter((id) => id != null && String(id).trim())
          .map(String);

        let keysById = new Map();
        let jiraLookupError = null;

        if ((input.resolveJiraKeys ?? true) && jiraIssueIds.length) {
          try {
            keysById = await getJiraIssuesBulk({ ids: jiraIssueIds, fields: ["summary"] });
          } catch (err) {
            jiraLookupError = err?.response?.data || err?.message || String(err);
          }
        }

        const rows = failed.map((tc, index) => {
          const jiraIssueId =
            tc?.issueId ?? tc?.jiraIssueId ?? tc?.jira?.issueId ?? null;
          const resolved = jiraIssueId != null ? keysById.get(String(jiraIssueId)) : null;

          return {
            index: index + 1,
            agileTestTestCaseId: tc?.id ?? null,
            name: resolved?.summary ?? "",
            jiraIssueId: jiraIssueId != null ? String(jiraIssueId) : "",
            jiraIssueKey: resolved?.key ?? "",
          };
        });

        const lines = [
          "# Failed Test Cases",
          "",
          `Execution ID: ${testExecutionId}`,
          "",
          "| # | Jira Test Case Issue ID | Jira Test Case Key |",
          "|---|-------------------------|--------------------|",
        ];
        for (const row of rows) {
          lines.push(`| ${row.index} | ${row.jiraIssueId} | ${row.jiraIssueKey} |`);
        }
        lines.push("");
        const markdown = lines.join("\n");

        let writtenTo = null;
        if (input.outputPath) {
          const target = path.isAbsolute(input.outputPath)
            ? input.outputPath
            : path.join(PROJECT_ROOT, input.outputPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, markdown, "utf8");
          writtenTo = path.relative(PROJECT_ROOT, target) || target;
        }

        return {
          projectId,
          testExecutionId,
          statusIdsChecked: [Number(failedResultId)],
          totalTestCases: items.length,
          failedCount: rows.length,
          rows,
          markdown,
          jiraLookupError,
          writtenTo,
          note: rows.length
            ? "No Jira key was resolved where jiraIssueKey is empty; check jiraLookupError if it is non-null."
            : "No test case in this execution has a matching failure result id.",
        };
      },
    });
  }
}

