import { z } from "zod";
import {
  getAgileTestJwt,
  createAgileTestTestCasesFromIssueIds,
  getAgileTestTestcasesByJiraIssueIds,
  createAgileTestTestStep,
  createAgileTestPrecondition,
} from "../../src/core/agiletestClient.js";
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
  }
}

