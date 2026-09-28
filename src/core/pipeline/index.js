import {
  runJiraPhase,
} from './jiraPhase.js';
import { runAgileTestPhase } from './agileTestPhase.js';
import {
  acquireLock,
  releaseLock,
  loadManifest,
  saveManifest,
  fingerprintFile,
} from './state.js';
import {
  parseCsv,
  groupByTestCase,
  resolveGeneratedCsvPath,
  resolveResultsCsvPath,
} from './csv.js';
import { createTimer, formatDuration } from './concurrency.js';
import { assertFreshCode } from './fingerprint.js';
import { findLinkedTestCasesBySummary } from '../jiraClient.js';
import { getAgileTestJwt, withAgileTestAuth, getAgileTestTestcasesByJiraIssueIds } from '../agiletestClient.js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`${name} must be set in .env or passed explicitly.`);
    err.code = 'EENV';
    throw err;
  }
  return value;
}

function normalize(value) {
  return String(value ?? '')
    .replace(/<\/?p>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Final safety net. Even if a guard is missed, a run reports failure loudly
// rather than leaving silently duplicated or misnumbered data behind.
//
// `agileTestState` lets the caller pass the state the AgileTest phase already
// fetched. When supplied, verification needs no extra API calls at all, which
// removes ~10s from a re-run. It is only trusted when every Jira id in the story
// is covered; otherwise the data is re-fetched so a partial state cannot cause
// a false pass.
export async function verifyStory({
  storyKey,
  projectId,
  agileTestState = null,
  log = () => {},
}) {
  const generatedPath = resolveGeneratedCsvPath(storyKey);
  const { rows: generatedRows } = parseCsv(generatedPath);
  const groups = groupByTestCase(generatedRows);
  const expectedByName = {};
  for (const [name, g] of groups) expectedByName[name] = g.length;

  const { bySummary, duplicates } = await findLinkedTestCasesBySummary({ storyKey });

  const issues = [];
  if (duplicates.length) {
    issues.push(`${duplicates.length} duplicate Jira test case(s): ${duplicates.map((d) => d.key).join(', ')}`);
  }
  for (const name of groups.keys()) {
    if (!bySummary.has(name)) issues.push(`missing Jira test case for "${name}"`);
  }
  for (const name of bySummary.keys()) {
    if (!groups.has(name)) issues.push(`unexpected Jira test case not in CSV: "${name}"`);
  }

  const expectedTotalSteps = [...groups.values()].reduce((s, g) => s + g.length, 0);
  let actualTotalSteps = 0;
  const mapped = [...bySummary.values()];

  const mappedIssueIds = mapped.map((t) => String(t.id));
  const suppliedIndex =
    agileTestState && mappedIssueIds.length
      ? new Map(agileTestState.map((s) => [String(s.issueId), s]))
      : null;
  const canReuseState =
    suppliedIndex && mappedIssueIds.every((id) => suppliedIndex.has(id));

  if (mapped.length) {
    let entries;

    if (canReuseState) {
      entries = mappedIssueIds.map((id) => suppliedIndex.get(id));
      log('Verification reused the state fetched during the AgileTest phase (no extra API calls).');
    } else {
      const jwt = await getAgileTestJwt();
      const cases = await withAgileTestAuth((token) =>
        getAgileTestTestcasesByJiraIssueIds(token, {
          projectId,
          jiraIssueIds: mappedIssueIds,
          expand: ['testSteps'],
        }),
      );
      const byIssue = new Map(cases.map((c) => [String(c.issueId), c]));
      entries = mappedIssueIds.map((id) => {
        const c = byIssue.get(id);
        return c ? { issueId: id, id: c.id, stepCount: (c.testSteps || []).length } : null;
      });
    }

    for (let i = 0; i < mappedIssueIds.length; i += 1) {
      const tc = mapped[i];
      const entry = entries[i];
      if (!entry) {
        issues.push(`no AgileTest test case mapped for ${tc.key}`);
        continue;
      }
      actualTotalSteps += entry.stepCount;
      const expected = expectedByName[tc.summary];
      if (expected !== undefined && entry.stepCount !== expected) {
        issues.push(`${tc.key} has ${entry.stepCount} step(s), expected ${expected}`);
      }
    }
  }

  const ok = issues.length === 0;
  log(
    ok
      ? `Verification passed: ${bySummary.size} test case(s), ${actualTotalSteps}/${expectedTotalSteps} steps.`
      : `Verification FAILED with ${issues.length} issue(s):\n  - ${issues.slice(0, 20).join('\n  - ')}`,
  );

  return {
    ok,
    issues,
    expectedTestCases: groups.size,
    actualTestCases: bySummary.size,
    expectedTotalSteps,
    actualTotalSteps,
  };
}

export async function runPipeline({
  storyKey,
  projectId,
  jiraProjectKey,
  assigneeAccountId,
  dryRun = false,
  concurrency = 5,
  verify = true,
  log = console.log,
}) {
  const total = createTimer();
  const timings = {};
  let lockFile = null;

  // Refuse to run when this process is executing code that no longer matches
  // disk. A long-lived server keeps its modules in memory, so without this a
  // run happily creates, updates and deletes using superseded logic while the
  // source on disk claims something else. Checked before the lock so a stale
  // process never takes a lock it would release without understanding.
  assertFreshCode({ context: `pipeline run for ${storyKey}` });

  try {
    log(`=== Pipeline for ${storyKey}${dryRun ? ' (DRY RUN - no changes)' : ''} ===`);

    // Refuse to overlap with another run on the same story. This is the guard
    // that prevents duplicate test cases.
    lockFile = acquireLock(storyKey);
    log('Acquired run lock.');

    const generatedPath = resolveGeneratedCsvPath(storyKey);
    const csvFingerprint = fingerprintFile(generatedPath);
    const previous = loadManifest(storyKey);
    if (previous && previous.csvFingerprint !== csvFingerprint) {
      log(
        `Note: generated CSV changed since the last run ` +
          `(${previous.csvFingerprint} -> ${csvFingerprint}); steps will be reconciled.`,
      );
    }
    log(`Generated CSV: ${generatedPath} (${csvFingerprint})`);

    const t0 = createTimer();
    const jira = await runJiraPhase({
      storyKey,
      jiraProjectKey,
      assigneeAccountId,
      dryRun,
      concurrency,
      log,
    });
    timings.jiraPhase = { ms: t0.elapsedMs(), label: t0.elapsedLabel() };
    log(`Jira phase done in ${t0.elapsedLabel()} (created ${jira.createdCount ?? 0}, reused ${jira.reusedCount ?? 0}).`);

    if (dryRun) {
      const results = {
        storyKey,
        dryRun: true,
        timings: { ...timings, total: { ms: total.elapsedMs(), label: total.elapsedLabel() } },
        totalDurationMs: total.elapsedMs(),
        jira,
      };
      log(`\nTOTAL (dry run): ${total.elapsedLabel()}`);
      return results;
    }

    if (jira.failures?.length) {
      // Partial Jira state would leave the AgileTest phase working from an
      // incomplete results CSV, which is how duplicates crept in before.
      const detail = jira.failures
        .map((f) => `${f.testCaseName || f.summary || '?'} (${f.error || 'unknown error'})`)
        .slice(0, 10)
        .join('; ');
      const err = new Error(
        `${jira.failures.length} Jira test case(s) failed to create, aborting before the ` +
          `AgileTest phase: ${detail}`,
      );
      err.code = 'EPARTIAL';
      throw err;
    }

    // Carry forward the previous run's per-test-case state so unchanged CSV
    // content is not reprocessed, then overlay this run's current mappings.
    const manifest = {
      storyKey,
      csvFingerprint,
      updatedAt: new Date().toISOString(),
      testCases: { ...(previous?.testCases || {}) },
    };
    for (const row of jira.rows || []) {
      const prior = manifest.testCases[row.test_case_name] || {};
      manifest.testCases[row.test_case_name] = {
        ...prior,
        jiraKey: row.jira_issue_key,
        jiraId: row.jira_issue_id,
      };
    }

    const t1 = createTimer();
    const agileTest = await runAgileTestPhase({
      storyKey,
      projectId,
      dryRun,
      concurrency,
      log,
    });
    timings.agileTestPhase = { ms: t1.elapsedMs(), label: t1.elapsedLabel() };
    log(
      `AgileTest phase done in ${t1.elapsedLabel()} ` +
        `(created steps ${agileTest.createdSteps ?? 0}, rebuilt ${agileTest.rebuilt ?? 0}, unchanged ${agileTest.unchanged ?? 0}, ` +
        `preconditions set ${agileTest.preconditionSet ?? 0}, updated ${agileTest.preconditionUpdated ?? 0}, failed ${agileTest.preconditionFailed ?? 0}).`,
    );

    // Record precondition work so a re-run does not redo it.
    const { rows: finalRows } = parseCsv(resolveResultsCsvPath(storyKey));
    for (const row of finalRows) {
      const entry = manifest.testCases[row.test_case_name];
      if (entry) {
        entry.agileTestId = row.agiletest_testcase_id;
        entry.csvFingerprint = csvFingerprint;
      }
    }
    manifest.updatedAt = new Date().toISOString();
    saveManifest(storyKey, manifest);

    let verification = null;
    if (verify) {
      const t2 = createTimer();
      verification = await verifyStory({
        storyKey,
        projectId,
        agileTestState: agileTest.agileTestState,
        log,
      });
      timings.verification = { ms: t2.elapsedMs(), label: t2.elapsedLabel() };
    }

    const totalMs = total.elapsedMs();
    const results = {
      storyKey,
      dryRun: false,
      timings: { ...timings, total: { ms: totalMs, label: total.elapsedLabel() } },
      totalDurationMs: totalMs,
      totalDurationLabel: formatDuration(totalMs),
      jira: { ...jira, rows: undefined },
      agileTest,
      verification,
    };

    log('');
    log('--- timing ---');
    for (const [phase, t] of Object.entries(timings)) {
      log(`  ${phase.padEnd(14)} ${t.label}`);
    }
    log(`  ${'TOTAL'.padEnd(14)} ${formatDuration(totalMs)}`);
    log(`\nTOTAL EXECUTION TIME: ${formatDuration(totalMs)} (${totalMs} ms)`);

    // A failed audit means the end state does not match the CSV, so the run is
    // reported as a failure even though the write calls themselves succeeded.
    if (verification && !verification.ok) {
      const err = new Error(
        `Pipeline completed in ${formatDuration(totalMs)} but verification failed with ` +
          `${verification.issues.length} issue(s): ${verification.issues.slice(0, 10).join(' | ')}`,
      );
      err.code = 'EVERIFY';
      err.result = results;
      throw err;
    }

    return results;
  } finally {
    if (lockFile) releaseLock(storyKey);
  }
}

export { runJiraPhase, runAgileTestPhase };
export { resolveGeneratedCsvPath, resolveResultsCsvPath };
