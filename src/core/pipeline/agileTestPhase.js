import {
  getAgileTestJwt,
  withAgileTestAuth,
  createAgileTestTestStep,
  createAgileTestPrecondition,
  updateAgileTestPrecondition,
  getAgileTestTestcasesByJiraIssueIds,
  createAgileTestTestCasesFromIssueIds,
  deleteAgileTestTestStep,
} from '../agiletestClient.js';
import { mapWithConcurrency, createTimer } from './concurrency.js';
import { groupByTestCase, parseCsv, writeResultsCsv, resolveGeneratedCsvPath, resolveResultsCsvPath } from './csv.js';

function normalize(value) {
  return String(value ?? '')
    .replace(/<\/?p>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function expectedStepsFor(groupRows) {
  return [...groupRows]
    .sort((a, b) => Number(a.step_number) - Number(b.step_number))
    .map((row) => ({
      stepNumber: Number(row.step_number),
      action: `<p>${row.action || ''}</p>`,
      expectedResult: `<p>${row.expected_result ?? row.expectedResult ?? ''}</p>`,
    }));
}

// Multiset (frequency map) of "action|expectedResult" keys. A plain Set is not
// enough: a case holding [step1, step1, step2] has the same set size as
// [step1, step2, step3] but is genuinely wrong, and that is exactly the kind of
// duplicated/misnumbered state we must repair.
function countSteps(steps) {
  const counts = new Map();
  for (const s of steps) {
    const key = `${normalize(s.action)}||${normalize(s.expectedResult)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function countsMatch(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) {
    if (b.get(key) !== count) return false;
  }
  return true;
}

function reconcilePlan(expected, existingSteps) {
  const existingCounts = countSteps(existingSteps);
  const expectedCounts = countSteps(expected);

  // Content matches exactly: identical multiset and identical length. Nothing to do.
  if (
    existingSteps.length === expected.length &&
    countsMatch(existingCounts, expectedCounts)
  ) {
    return { missing: [], rebuild: false };
  }

  // Anything else (wrong count, duplicated step, missing step, altered text)
  // is rebuilt wholesale so stepIndex ends up exactly 0..n-1.
  return { missing: expected.slice(), rebuild: true };
}

export async function runAgileTestPhase({
  storyKey,
  projectId,
  dryRun = false,
  concurrency = 5,
  log = () => {},
}) {
  const timer = createTimer();

  const generatedPath = resolveGeneratedCsvPath(storyKey);
  const resultsPath = resolveResultsCsvPath(storyKey);
  const { rows: generatedRows } = parseCsv(generatedPath);
  const groups = groupByTestCase(generatedRows);

  const { rows: resultsRows } = parseCsv(resultsPath);
  if (!resultsRows.length) {
    const err = new Error(
      `Results CSV has no rows at ${resultsPath}. Run the Jira phase first so Jira test cases exist.`,
    );
    err.code = 'ENORESULTS';
    throw err;
  }

  const targetRows = resultsRows
    .map((r) => ({
      test_case_name: (r.test_case_name || '').trim(),
      jira_issue_id: (r.jira_issue_id || '').trim(),
      priority: r.priority || '',
      jira_issue_key: r.jira_issue_key || '',
      agiletest_testcase_id: r.agiletest_testcase_id || '',
    }))
    .filter((r) => r.test_case_name && r.jira_issue_id);

  log(`Loaded ${targetRows.length} test case(s) from ${resultsPath}`);

  const jiraIssueIds = targetRows.map((r) => r.jira_issue_id);

  // Single bulk lookup with both expansions. The old code fetched the mapping
  // and then immediately fetched mapping + steps + preconditions again, so every
  // run paid for the same test cases twice.
  //
  // Measured: preconditions for 24 test cases ~5s, testSteps ~9s. Latency on this
  // AgileTest instance is highly variable under load, so fewer round trips is
  // better. Note that `updatedAt` is NOT a usable change guard here - verified by
  // probe that creating and deleting a step leaves updatedAt unchanged - so steps
  // are always read rather than trusted from a cache.
  let byIssue = new Map();
  let missingIssueIds;

  await withAgileTestAuth(async (token) => {
    const cases = await getAgileTestTestcasesByJiraIssueIds(token, {
      projectId,
      jiraIssueIds: jiraIssueIds,
      expand: ['testSteps', 'preconditions'],
    });
    for (const c of cases) byIssue.set(String(c.issueId), c);
    return cases;
  });

  missingIssueIds = jiraIssueIds.filter((id) => !byIssue.has(String(id)));
  log(
    `AgileTest: ${byIssue.size} already mapped, ${missingIssueIds.length} need creating.`,
  );

  if (dryRun) {
    return {
      dryRun: true,
      resultsCsvPath: resultsPath,
      total: targetRows.length,
      alreadyMapped: byIssue.size,
      toCreate: missingIssueIds.length,
      durationMs: timer.elapsedMs(),
    };
  }

  if (missingIssueIds.length) {
    // Single bulk create instead of one call per test case.
    await withAgileTestAuth((token) =>
      createAgileTestTestCasesFromIssueIds(token, {
        projectId,
        folderId: 0,
        testCaseIssueIds: missingIssueIds,
      }),
    );
    log(`Bulk create requested for ${missingIssueIds.length} test case(s); waiting for AgileTest to map them.`);

    // AgileTest maps Jira issues asynchronously, so poll until they appear.
    const maxAttempts = 20;
    const waitMs = 3000;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await new Promise((r) => setTimeout(r, waitMs));
      byIssue = new Map();
      await withAgileTestAuth(async (token) => {
        const cases = await getAgileTestTestcasesByJiraIssueIds(token, {
          projectId,
          jiraIssueIds: missingIssueIds,
          expand: [],
        });
        for (const c of cases) byIssue.set(String(c.issueId), c);
        return cases;
      });
      const still = missingIssueIds.filter((id) => !byIssue.has(String(id)));
      if (!still.length) {
        log(`All ${missingIssueIds.length} test case(s) mapped after ~${(attempt * waitMs) / 1000}s.`);
        break;
      }
      log(`  waiting on ${still.length} unmapped test case(s) (attempt ${attempt}/${maxAttempts})...`);
      if (attempt === maxAttempts) {
        log(`WARNING: ${still.length} AgileTest test case(s) never appeared and will be skipped.`);
      }
    }
  }

  // The initial bulk lookup already fetched testSteps and preconditions for
  // every mapped test case, so steps are read straight from it. Only test cases
  // created during this run need a follow-up fetch, because they did not exist
  // when the first lookup ran.
  const createdThisRun = new Set(missingIssueIds);
  if (createdThisRun.size) {
    await withAgileTestAuth(async (token) => {
      const cases = await getAgileTestTestcasesByJiraIssueIds(token, {
        projectId,
        jiraIssueIds: [...createdThisRun],
        expand: ['testSteps', 'preconditions'],
      });
      for (const c of cases) byIssue.set(String(c.issueId), c);
      return cases;
    });
  }

  const stepsByIssue = new Map();
  for (const [id, c] of byIssue) {
    stepsByIssue.set(id, c.testSteps || []);
  }

  const summary = {
    createdSteps: 0,
    rebuilt: 0,
    unchanged: 0,
    skipped: 0,
    preconditionSet: 0,
    preconditionUpdated: 0,
    preconditionFailed: 0,
    preconditionDuplicated: 0,
    preconditionErrors: [],
    duplicatePreconditionKeys: [],
  };

  await mapWithConcurrency(targetRows, concurrency, async (row) => {
    const idKey = String(row.jira_issue_id);
    const agileTestCase = byIssue.get(idKey);
    const groupRows = groups.get(row.test_case_name);

    if (!agileTestCase || !groupRows) {
      summary.skipped += 1;
      log(`SKIP ${row.jira_issue_key || idKey} - no AgileTest test case mapped (${row.test_case_name})`);
      return;
    }

    row.agiletest_testcase_id = agileTestCase.id;
    const testCaseId = agileTestCase.id;
    const expected = expectedStepsFor(groupRows);
    const existingSteps = stepsByIssue.get(idKey) || [];
    const { missing, rebuild } = reconcilePlan(expected, existingSteps);

    // Fast path: steps are already exactly right, so a re-run writes nothing.
    // Preconditions are still evaluated below.
    if (!rebuild && missing.length === 0 && existingSteps.length === expected.length) {
      summary.unchanged += 1;
    } else {
      // A rebuild deletes every existing step first so stepIndex numbering ends up
      // exact. Previously steps were only ever appended, which is what produced
      // 12-step test cases where 4 were expected.
      if (rebuild && existingSteps.length) {
        for (const s of existingSteps) {
          await withAgileTestAuth((token) =>
            deleteAgileTestTestStep(token, { projectId, stepId: s.id }),
          );
        }
        summary.rebuilt += 1;
        log(`rebuilt ${row.jira_issue_key} (at ${testCaseId}): cleared ${existingSteps.length} step(s)`);
      }

      const toCreate = rebuild ? expected : missing;
      for (const step of toCreate) {
        await withAgileTestAuth((token) =>
          createAgileTestTestStep(token, {
            projectId,
            testCaseId,
            action: step.action,
            expectedResult: step.expectedResult,
            stepIndex: step.stepNumber - 1,
          }),
        );
        summary.createdSteps += 1;
      }
    }

    // Preconditions: AgileTest's create endpoint is create-only and errors if one
    // is already linked, so the existing preconditions are read first and the
    // record is updated in place when the text differs. Re-posting blindly is
    // what produced duplicate preconditions and aborted earlier runs.
    const preconditionText = (groupRows[0]?.precondition || '').trim();
    if (preconditionText) {
      const existing = (agileTestCase.preconditions || [])
        .map((p) => ({ id: p.id, details: normalize(p.details) }))
        .filter((p) => p.details);

      const alreadyCorrect = existing.some((p) => p.details === normalize(preconditionText));

      if (!alreadyCorrect) {
        try {
          if (existing.length) {
            await withAgileTestAuth((token) =>
              updateAgileTestPrecondition(token, {
                preconditionId: existing[0].id,
                projectId,
                title: 'Precondition',
                details: preconditionText,
              }),
            );
            summary.preconditionUpdated += 1;
          } else {
            await withAgileTestAuth((token) =>
              createAgileTestPrecondition(token, {
                testCaseId,
                body: {
                  precondition: { title: 'Precondition', details: preconditionText },
                  projectId,
                },
              }),
            );
            summary.preconditionSet += 1;
          }
        } catch (err) {
          // Non-fatal: a missing precondition must not lose the step work or the
          // AgileTest ids for every other test case in the run.
          summary.preconditionFailed += 1;
          summary.preconditionErrors.push(
            `${row.jira_issue_key || idKey}: ${err?.response?.data?.message || err?.message || err}`,
          );
          log(`WARNING: precondition failed for ${row.jira_issue_key || idKey}: ${err?.response?.data?.message || err?.message || err}`);
        }
      } else if (existing.length > 1) {
        summary.preconditionDuplicated += 1;
        summary.duplicatePreconditionKeys.push(
          `${row.jira_issue_key || idKey} (${existing.length} copies)`,
        );
      }
    }
  });

  writeResultsCsv(resultsPath, targetRows);
  log(`Updated ${resultsPath} with AgileTest test case ids.`);

  // Hand the already-fetched AgileTest state back so the verification step can
  // confirm the result without re-querying the API for every test case.
  const agileTestState = [...byIssue.values()].map((c) => ({
    issueId: String(c.issueId),
    id: c.id,
    stepCount: (c.testSteps || []).length,
  }));

  return {
    dryRun: false,
    resultsCsvPath: resultsPath,
    total: targetRows.length,
    ...summary,
    agileTestState,
    durationMs: timer.elapsedMs(),
  };
}
