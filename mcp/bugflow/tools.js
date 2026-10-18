import { z } from "zod";
import {
  getJiraIssue,
  adfToText,
  searchJiraAssignableUser,
  addJiraIssueLink,
  assignJiraIssue,
  createJiraBug,
  findLinkedBugs,
} from "../../src/core/jiraClient.js";
import {
  getAgileTestJwt,
  getAgileTestExecutionsByJiraIssueIds,
  getAgileTestExecutionTestCases,
} from "../../src/core/agiletestClient.js";

// ---------------------------------------------------------------------------
// Chunked automated bug flow.
//
// Three tools, one responsibility each, designed so the drafting "thinking"
// happens in the chat model between chunk 1 and chunk 2 - never hidden inside
// a tool call:
//
//   1. jira_prepare_bug_drafts   (read-only)  gather raw material + rules
//   2. jira_create_bug_from_draft (write)     create one bug from an edited draft
//   3. jira_link_and_finalize_bug (write)     links + mandatory reassignment
//
// The bug-summary/description rules follow skills/automated-bug-flow-local.md.
// ---------------------------------------------------------------------------

const BUG_RULES = {
  descriptionPattern:
    'Single scenario sentence: "When the user <does scenario/action>, then <actual behavior that happens but should not happen>." ' +
    "No meta text (e.g. 'Automated regression indicates...'), no environment/references/notes sections in the description.",
  classification:
    'Classify each draft as "ui" (layout/visual behavior) or "functional" (business logic). ' +
    "The reassignment in chunk 3 uses this: UI bugs go to UI_DEVELOPER, functional bugs to FUNCTIONAL_DEVELOPER (.env display names).",
  environment: process.env.JIRA_BUG_ENVIRONMENT || "Alpha – Chrome (latest)",
};

function resolveProjectId(input) {
  const projectId = String(input?.projectId || process.env.AGILETEST_PROJECT_ID || "").trim();
  if (!projectId) {
    throw new Error("AgileTest project id is required: pass projectId or set AGILETEST_PROJECT_ID in .env.");
  }
  return projectId;
}

function executionItemsOf(testCase) {
  const raw = testCase?.testExecutionItems;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  return [];
}

// Collect failed test cases for a story: follow the story's Jira issue links
// to TestExecution issues, resolve them to AgileTest executions, and keep
// cases whose result id matches failedResultId. (Same resolution as
// agiletest_get_failed_testcases_by_story, factored for reuse.)
async function collectFailedCases({ storyKey, projectId, failedResultId, testExecutionIssueTypeName }) {
  const execTypeName = (
    testExecutionIssueTypeName ||
    process.env.JIRA_TESTEXEC_ISSUE_TYPE ||
    "TestExecution"
  ).trim().toLowerCase();

  const story = await getJiraIssue(storyKey);

  const executionIssues = [];
  for (const link of story?.fields?.issuelinks || []) {
    const other = link?.outwardIssue || link?.inwardIssue;
    const typeName = String(other?.fields?.issuetype?.name || "").trim().toLowerCase();
    if (other?.id && typeName === execTypeName) {
      executionIssues.push({ id: String(other.id), key: String(other.key || "") });
    }
  }

  if (!executionIssues.length) {
    return {
      story,
      failedCases: [],
      unresolvedExecutions: [],
      executionsChecked: [],
    };
  }

  const jwt = await getAgileTestJwt();
  const executions = await getAgileTestExecutionsByJiraIssueIds(jwt, {
    projectId,
    testExecutionIssueIds: executionIssues.map((e) => e.id),
  });
  const byJiraId = new Map(executions.map((e) => [String(e.jiraIssueId ?? e.issueId), e]));

  const unresolvedExecutions = executionIssues
    .filter((e) => !byJiraId.has(e.id))
    .map((e) => ({ jiraExecutionIssueId: e.id, jiraExecutionIssueKey: e.key }));

  const failedCases = [];
  const executionsChecked = [];

  for (const { id: jiraExecId, key: jiraExecKey } of executionIssues) {
    const exec = byJiraId.get(jiraExecId);
    if (!exec) continue;
    const testExecutionId = String(exec.id);
    const items = await getAgileTestExecutionTestCases(jwt, { projectId, testExecutionId });

    let failedInExec = 0;
    for (const tc of items) {
      const failed = executionItemsOf(tc).some(
        (item) => Number(item?.result) === Number(failedResultId),
      );
      if (!failed) continue;
      failedInExec += 1;
      const jiraIssueId = tc?.issueId ?? tc?.jiraIssueId ?? tc?.jira?.issueId ?? null;
      if (jiraIssueId != null) {
        failedCases.push({
          jiraTestCaseIssueId: String(jiraIssueId),
          agileTestTestCaseId: tc?.id ?? null,
          jiraExecutionIssueKey: jiraExecKey,
          testExecutionId,
        });
      }
    }
    executionsChecked.push({
      jiraExecutionIssueKey: jiraExecKey,
      testExecutionId,
      totalTestCases: items.length,
      failedCount: failedInExec,
    });
  }

  return { story, failedCases, unresolvedExecutions, executionsChecked };
}

// Fetch the full Jira Test Case issue and flatten the fields the drafting
// model needs. Steps/expected custom-field ids are project-specific; when the
// configured field is absent the raw text is simply empty and the model works
// from the description instead.
function extractTestCaseMaterial(issue) {
  const stepsField = process.env.JIRA_BUG_STEPS_FIELD || "customfield_10334";
  const expectedField = process.env.JIRA_BUG_EXPECTED_FIELD || "customfield_10335";
  const fields = issue?.fields || {};

  return {
    jiraTestCaseIssueId: String(issue.id),
    jiraTestCaseKey: issue.key,
    summary: fields.summary ?? "",
    descriptionText: adfToText(fields.description),
    storedStepsText: adfToText(fields[stepsField]),
    storedExpectedText: adfToText(fields[expectedField]),
    priorityName: fields.priority?.name ?? "",
    labels: Array.isArray(fields.labels) ? fields.labels : [],
  };
}

function extractStoryMaterial(story) {
  const fields = story?.fields || {};
  return {
    storyKey: story.key,
    storySummary: fields.summary ?? "",
    storyDescriptionText: adfToText(fields.description),
    priorityName: fields.priority?.name ?? "",
    labels: Array.isArray(fields.labels) ? fields.labels : [],
  };
}

// Read-only: resolve UI_DEVELOPER / FUNCTIONAL_DEVELOPER display names from
// .env to accountIds, so chunk 3's plan shows exactly who will get the bug.
async function previewAssigneeResolution(classification) {
  const name =
    classification === "ui"
      ? process.env.UI_DEVELOPER
      : classification === "functional"
        ? process.env.FUNCTIONAL_DEVELOPER
        : null;
  if (!name || !String(name).trim()) {
    return { displayName: null, accountId: null, fallbackAccountId: process.env.JIRA_ASSIGNEE_ACCOUNT_ID || null };
  }
  try {
    const user = await searchJiraAssignableUser({ displayName: name });
    return {
      displayName: name,
      accountId: user?.accountId ?? null,
      fallbackAccountId: process.env.JIRA_ASSIGNEE_ACCOUNT_ID || null,
    };
  } catch {
    return { displayName: name, accountId: null, fallbackAccountId: process.env.JIRA_ASSIGNEE_ACCOUNT_ID || null };
  }
}

export class BugFlowTools {
  static register(server) {
    // -----------------------------------------------------------------
    // Chunk 1 (read-only): gather raw material + rules for bug drafting.
    // -----------------------------------------------------------------
    server.tool("jira_prepare_bug_drafts", {
      description:
        "Chunk 1 of the automated bug flow (read-only). For a story's failed test cases, gathers everything " +
        "needed to draft Jira bugs: each failed Test Case's summary/description/steps/expected, the linked " +
        "Story's description/priority, existing open bugs (idempotency), and the bug-writing rules " +
        "(summary pattern, description pattern, UI/functional classification guidance). " +
        "It does NOT write anything and does NOT compose the final bug text - the drafting model must " +
        "build summary/description/steps/expected/actual from this raw material, present the drafts for " +
        "approval, then call jira_create_bug_from_draft per approved draft.",
      inputSchema: z.object({
        storyKey: z.string().optional().describe("Jira story key, e.g. 'SHP-4401'. Defaults to JIRA_STORY_KEY in .env."),
        testCaseKeys: z
          .array(z.string())
          .optional()
          .describe("Explicit Test Case keys to prepare drafts for (skips AgileTest failure lookup)."),
        projectId: z.string().optional().describe("AgileTest project id; defaults to AGILETEST_PROJECT_ID in .env."),
        failedResultId: z
          .number()
          .int()
          .optional()
          .default(28913)
          .describe("Result status id treated as failure. Default 28913 (fail)."),
        testExecutionIssueTypeName: z
          .string()
          .optional()
          .describe('Jira issue type name of a Test Execution. Default "TestExecution".'),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const storyKey = String(input.storyKey || process.env.JIRA_STORY_KEY || "").trim();
        const explicitKeys = (input.testCaseKeys || []).map((k) => String(k).trim()).filter(Boolean);

        if (!storyKey && !explicitKeys.length) {
          throw new Error("Provide storyKey (or JIRA_STORY_KEY in .env) or testCaseKeys.");
        }

        let failedCases = [];
        let unresolvedExecutions = [];
        let executionsChecked = [];
        let story = null;

        if (explicitKeys.length) {
          // Explicit list: resolve the story from the first test case's links if not given.
          const first = await getJiraIssue(explicitKeys[0]);
          if (!storyKey) {
            for (const link of first?.fields?.issuelinks || []) {
              const other = link?.outwardIssue || link?.inwardIssue;
              if (other?.key && String(other?.fields?.issuetype?.name || "").toLowerCase() === "story") {
                story = await getJiraIssue(other.key);
                break;
              }
            }
          }
          failedCases = [];
        } else {
          const collected = await collectFailedCases({
            storyKey,
            projectId: resolveProjectId(input),
            failedResultId: input.failedResultId ?? 28913,
            testExecutionIssueTypeName: input.testExecutionIssueTypeName,
          });
          story = collected.story;
          failedCases = collected.failedCases;
          unresolvedExecutions = collected.unresolvedExecutions;
          executionsChecked = collected.executionsChecked;
        }

        const resolvedStoryKey = story?.key || storyKey;
        const keysToDraft = explicitKeys.length
          ? explicitKeys
          : [...new Set(failedCases.map((f) => f.jiraTestCaseIssueId))];

        const drafts = [];
        for (const idOrKey of keysToDraft) {
          const tcIssue = await getJiraIssue(idOrKey);
          const material = extractTestCaseMaterial(tcIssue);

          // Idempotency: surface open bugs already linked to this test case.
          const linkedBugs = await findLinkedBugs({ issueIdOrKey: tcIssue.key });
          const openBugs = linkedBugs.filter((b) => b.statusCategory !== "done");

          drafts.push({
            ...material,
            storyKey: resolvedStoryKey,
            existingOpenBugKeys: openBugs.map((b) => b.key),
            // The model composes these in chat; they are NOT final text.
            draft: {
              summary: "",
              description: "",
              steps: "",
              expectedResults: "",
              actualResults: "",
              classification: "",
              labels: [],
              environment: BUG_RULES.environment,
            },
          });
        }

        return {
          story: story ? extractStoryMaterial(story) : null,
          executionsChecked,
          unresolvedExecutions,
          failedCount: failedCases.length,
          bugWritingRules: {
            summaryPatterns: {
              adminPortal: "Admin Portal >> <Page or Module> [>> <Child module>] >> <short defect title>",
              client: "Client >> <Module or service name> >> <short defect title>",
              arabicVersionPrefix: '(Arabic Version) prefix for Arabic-specific issues, e.g. "(Arabic Version) Client >> ..."',
            },
            descriptionPattern: BUG_RULES.descriptionPattern,
            classification: BUG_RULES.classification,
            environmentDefault: BUG_RULES.environment,
            labelsGuidance:
              'Use "AdminPortal" for Admin Portal bugs, "Client" for client-website/AI-bot bugs (or pass explicit labels).',
            assigneesFromEnv: {
              uiDeveloper: process.env.UI_DEVELOPER || null,
              functionalDeveloper: process.env.FUNCTIONAL_DEVELOPER || null,
              defaultAccountId: process.env.JIRA_ASSIGNEE_ACCOUNT_ID || null,
            },
            nextStep:
              "Draft summary/description/steps/expected/actual for each item below in chat, get approval, " +
              "then call jira_create_bug_from_draft once per approved draft, followed by jira_link_and_finalize_bug.",
          },
          drafts,
        };
      },
    });

    // -----------------------------------------------------------------
    // Chunk 2 (write): create one bug from an approved draft.
    // -----------------------------------------------------------------
    server.tool("jira_create_bug_from_draft", {
      description:
        "Chunk 2 of the automated bug flow. Creates ONE Jira Bug from an approved draft (the text the " +
        "drafting model composed from jira_prepare_bug_drafts raw material, reviewed in chat). " +
        "Idempotent: unless forceCreate, checks the source Test Case's links first and refuses to duplicate " +
        "an open bug (returns existingBugKey instead). Previews by default - dryRun returns plannedAction " +
        "with the resolved default assignee and writes nothing. The created bug still needs " +
        "jira_link_and_finalize_bug (links + mandatory UI/functional reassignment).",
      inputSchema: z.object({
        summary: z.string().describe("Final bug summary, following the summary pattern from chunk 1."),
        description: z
          .string()
          .describe('Final bug description: single "When the user ... then ..." scenario sentence.'),
        steps: z.string().optional().describe("Numbered user-action steps (one per line)."),
        expectedResults: z.string().optional().describe("Correct expected behavior paragraph."),
        actualResults: z.string().optional().describe("Actual observed behavior paragraph."),
        storyKey: z.string().optional().describe("Source story key; linked to the bug in chunk 3."),
        testCaseKey: z
          .string()
          .optional()
          .describe("Source Test Case key; used for the duplicate check and linked in chunk 3."),
        classification: z
          .enum(["ui", "functional"])
          .optional()
          .describe('Bug type for chunk 3 reassignment: "ui" -> UI_DEVELOPER, "functional" -> FUNCTIONAL_DEVELOPER.'),
        labels: z.array(z.string()).optional().describe('Labels, e.g. ["AdminPortal"] or ["Client"].'),
        environment: z.string().optional().describe("Environment text; defaults to JIRA_BUG_ENVIRONMENT or 'Alpha – Chrome (latest)'."),
        priorityName: z.string().optional().describe("Priority name; defaults to the story/test case priority when available."),
        forceCreate: z
          .boolean()
          .optional()
          .default(false)
          .describe("Create even if an open bug already links to the test case. Default false."),
        dryRun: z
          .boolean()
          .optional()
          .default(true)
          .describe("Preview only; make no changes. This is the DEFAULT. Pass dryRun=false to create."),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const summary = String(input.summary || "").trim();
        const description = String(input.description || "").trim();
        if (!summary) throw new Error("summary is required.");
        if (!description) throw new Error("description is required.");

        const dryRun = input.dryRun ?? true;

        // Idempotency guard: an open bug already covering this test case.
        let existingBugKey = null;
        if (input.testCaseKey && !input.forceCreate) {
          const openBugs = (await findLinkedBugs({ issueIdOrKey: input.testCaseKey })).filter(
            (b) => b.statusCategory !== "done",
          );
          if (openBugs.length) {
            return {
              created: false,
              dryRun,
              existingBugKeys: openBugs.map((b) => b.key),
              plannedAction:
                `An open bug (${openBugs.map((b) => b.key).join(", ")}) already links to ${input.testCaseKey}. ` +
                "Update that bug instead, or pass forceCreate=true to create another.",
            };
          }
        }

        const defaultAssignee = process.env.JIRA_ASSIGNEE_ACCOUNT_ID || null;
        const plannedAction = {
          action: "create-bug",
          projectKey: process.env.JIRA_PROJECT_KEY || null,
          issueType: process.env.JIRA_BUG_ISSUETYPE_NAME || "Bug",
          summary,
          description,
          steps: input.steps || "",
          expectedResults: input.expectedResults || "",
          actualResults: input.actualResults || "",
          environment: input.environment || process.env.JIRA_BUG_ENVIRONMENT || "Alpha – Chrome (latest)",
          labels: input.labels || [],
          priorityName: input.priorityName || null,
          initialAssigneeAccountId: defaultAssignee,
          classification: input.classification || null,
          willBeReassignedInChunk3:
            input.classification === "ui"
              ? `UI_DEVELOPER (${process.env.UI_DEVELOPER || "not set"})`
              : input.classification === "functional"
                ? `FUNCTIONAL_DEVELOPER (${process.env.FUNCTIONAL_DEVELOPER || "not set"})`
                : "depends on classification passed to jira_link_and_finalize_bug",
        };

        if (dryRun) {
          return { created: false, dryRun: true, plannedAction, existingBugKey };
        }

        const result = await createJiraBug({
          summary,
          description,
          steps: input.steps,
          expectedResults: input.expectedResults,
          actualResults: input.actualResults,
          environment: input.environment,
          labels: input.labels,
          priorityName: input.priorityName,
          assigneeAccountId: defaultAssignee,
        });

        return {
          created: true,
          dryRun: false,
          bugKey: result.key,
          bugId: result.id,
          plannedAction,
          nextStep:
            "Call jira_link_and_finalize_bug with this bugKey, the storyKey and testCaseKey, and the " +
            "classification - the link + reassignment step is mandatory and must be the last step.",
        };
      },
    });

    // -----------------------------------------------------------------
    // Chunk 3 (write): links + mandatory reassignment. Never skippable.
    // -----------------------------------------------------------------
    server.tool("jira_link_and_finalize_bug", {
      description:
        "Chunk 3 of the automated bug flow (mandatory last step). For a bug created by " +
        "jira_create_bug_from_draft: links it to the source Story ('Relates') and to the source Test Case " +
        "(configured test link type, bug side reads 'is tested by'), then reassigns it per classification - " +
        '"ui" to the UI_DEVELOPER and "functional" to the FUNCTIONAL_DEVELOPER from .env (resolved by display ' +
        "name; falls back to the current/default assignee when resolution fails). Existing links are skipped " +
        "so the call is safe to repeat. Previews by default (dryRun).",
      inputSchema: z.object({
        bugKey: z.string().describe("Bug key created in chunk 2."),
        storyKey: z.string().optional().describe("Story to link ('Relates'). Defaults to the bug's linked story if already known."),
        testCaseKey: z.string().optional().describe("Test Case to link ('is tested by')."),
        classification: z
          .enum(["ui", "functional"])
          .optional()
          .describe('Drives reassignment: "ui" -> UI_DEVELOPER, "functional" -> FUNCTIONAL_DEVELOPER.'),
        assigneeOverrideAccountId: z
          .string()
          .optional()
          .describe("Explicit accountId to assign instead of resolving UI_DEVELOPER/FUNCTIONAL_DEVELOPER."),
        dryRun: z
          .boolean()
          .optional()
          .default(true)
          .describe("Preview only; make no changes. This is the DEFAULT. Pass dryRun=false to apply."),
      }),
      outputSchema: z.any(),
      async handler(input) {
        const bugKey = String(input.bugKey || "").trim();
        if (!bugKey) throw new Error("bugKey is required.");

        const bug = await getJiraIssue(bugKey);
        const bugTypeName = (process.env.JIRA_BUG_ISSUETYPE_NAME || "Bug").toLowerCase();
        if (String(bug?.fields?.issuetype?.name || "").trim().toLowerCase() !== bugTypeName) {
          throw new Error(`${bugKey} is of type "${bug?.fields?.issuetype?.name}", expected "${bugTypeName}".`);
        }

        const storyKey = String(input.storyKey || "").trim() || null;
        const testCaseKey = String(input.testCaseKey || "").trim() || null;
        const linkTypeName = process.env.JIRA_ISSUE_LINK_TYPE || "AgileTest";
        const relatestTypeName = process.env.JIRA_RELATES_LINK_TYPE || "Relates";

        const existingLinks = (bug?.fields?.issuelinks || []).map((l) => {
          const other = l?.outwardIssue || l?.inwardIssue;
          return { key: other?.key || "", type: l?.type?.name || "" };
        });
        const hasLinkTo = (key) => existingLinks.some((l) => l.key === key);

        const plan = {
          links: [],
          assignee: null,
        };

        if (storyKey) {
          plan.links.push({
            to: storyKey,
            linkType: relatestTypeName,
            skipped: hasLinkTo(storyKey),
            direction: "bug relates to story",
          });
        }
        if (testCaseKey) {
          plan.links.push({
            to: testCaseKey,
            linkType: linkTypeName,
            skipped: hasLinkTo(testCaseKey),
            direction: "bug is tested by test case",
          });
        }

        // Resolve the final assignee: explicit override > classified developer > keep current.
        let assigneeDecision;
        if (input.assigneeOverrideAccountId) {
          assigneeDecision = {
            accountId: input.assigneeOverrideAccountId,
            source: "assigneeOverrideAccountId",
            displayName: null,
          };
        } else if (input.classification) {
          const resolved = await previewAssigneeResolution(input.classification);
          assigneeDecision = resolved.accountId
            ? { accountId: resolved.accountId, source: `env ${input.classification} developer`, displayName: resolved.displayName }
            : {
                accountId: resolved.fallbackAccountId,
                source: resolved.displayName
                  ? `fallback (could not resolve "${resolved.displayName}" to an accountId)`
                  : "fallback (developer env var not set)",
                displayName: resolved.displayName,
              };
        } else {
          assigneeDecision = {
            accountId: null,
            source: "keep current assignee (no classification or override given)",
            displayName: null,
          };
        }
        plan.assignee = assigneeDecision;

        const currentAssignee = bug?.fields?.assignee?.accountId ?? null;
        const dryRun = input.dryRun ?? true;

        if (dryRun) {
          return { applied: false, dryRun: true, bugKey, currentAssigneeAccountId: currentAssignee, plannedAction: plan };
        }

        const applied = { links: [], assignee: null };

        if (storyKey && !hasLinkTo(storyKey)) {
          await addJiraIssueLink({ inwardIssueKey: bugKey, outwardIssueKey: storyKey, linkTypeName: relatestTypeName });
          applied.links.push({ to: storyKey, linkType: relatestTypeName, added: true });
        } else if (storyKey) {
          applied.links.push({ to: storyKey, linkType: relatestTypeName, added: false, reason: "link already exists" });
        }

        if (testCaseKey && !hasLinkTo(testCaseKey)) {
          // inward = bug so the bug side reads "is tested by" the test case.
          await addJiraIssueLink({ inwardIssueKey: bugKey, outwardIssueKey: testCaseKey, linkTypeName });
          applied.links.push({ to: testCaseKey, linkType: linkTypeName, added: true });
        } else if (testCaseKey) {
          applied.links.push({ to: testCaseKey, linkType: linkTypeName, added: false, reason: "link already exists" });
        }

        if (assigneeDecision.accountId && assigneeDecision.accountId !== currentAssignee) {
          await assignJiraIssue({ issueIdOrKey: bugKey, accountId: assigneeDecision.accountId });
          applied.assignee = { accountId: assigneeDecision.accountId, source: assigneeDecision.source };
        } else {
          applied.assignee = {
            accountId: currentAssignee,
            source:
              assigneeDecision.accountId === currentAssignee
                ? "already assigned to the target user"
                : assigneeDecision.source,
          };
        }

        return { applied: true, dryRun: false, bugKey, currentAssigneeAccountId: currentAssignee, ...applied };
      },
    });
  }
}
