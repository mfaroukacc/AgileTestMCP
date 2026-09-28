import path from 'path';
import {
  getJiraIssueAssignee,
  getJiraIssuesBulk,
  assignJiraIssue,
  createJiraTestCase,
  findLinkedTestCasesBySummary,
} from '../jiraClient.js';
import { mapWithConcurrency, createTimer } from './concurrency.js';
import { dedupeStory } from './dedupe.js';
import { groupByTestCase, preflightGeneratedCsv, writeResultsCsv, resolveGeneratedCsvPath, resolveResultsCsvPath, parseCsv } from './csv.js';
import fs from 'fs';

const EXPECTED_TYPE = process.env.JIRA_TESTCASE_ISSUETYPE_NAME || 'Test Case';

function mapCsvPriorityToName(csvPriority) {
  const value = String(csvPriority ?? '').trim().toLowerCase();
  switch (value) {
    case '1':
    case 'high':
      return 'High';
    case '2':
    case 'medium':
      return 'Medium';
    case '3':
    case 'low':
      return 'Low';
    default:
      return undefined;
  }
}

export async function runJiraPhase({
  storyKey,
  jiraProjectKey,
  assigneeAccountId,
  dryRun = false,
  concurrency = 5,
  log = () => {},
}) {
  const timer = createTimer();

  const csvPath = resolveGeneratedCsvPath(storyKey);
  log(`Reading CSV from ${csvPath}`);
  const { groups } = preflightGeneratedCsv(csvPath);
  log(`Preflight OK. ${groups.size} test cases, ${[...groups.values()].reduce((s, r) => s + r.length, 0)} steps.`);

  // A failed lookup used to be logged as a warning and then the run continued
  // without dedup, which silently turned into mass duplicate creation.
  let existing;
  try {
    existing = await findLinkedTestCasesBySummary({ storyKey });
  } catch (err) {
    const wrapped = new Error(
      `Could not read existing test cases linked to ${storyKey}, so duplication cannot be prevented. ` +
        `Aborting without making any changes. Cause: ${err?.response?.status || ''} ${err?.message || err}`,
    );
    wrapped.code = 'EDEDUPLOOKUP';
    throw wrapped;
  }

  const { bySummary, duplicates, total } = existing;
  log(`Found ${total} linked test case(s); ${bySummary.size} unique summaries.`);

  // Pre-existing duplicates are cleaned up automatically. They are always a
  // leftover from an earlier overlapping run, and leaving them in place is what
  // makes a story look like it has extra test cases. A dry run only reports.
  let dedupe = null;
  if (duplicates.length) {
    log(
      `${duplicates.length} pre-existing duplicate test case(s) detected on this story: ` +
        duplicates.map((d) => d.key).join(', '),
    );
    dedupe = await dedupeStory({ storyKey, dryRun, log });
    if (!dryRun && dedupe.deleted?.length) {
      // Re-read so bySummary reflects the post-deletion reality.
      const refreshed = await findLinkedTestCasesBySummary({ storyKey });
      bySummary.clear();
      for (const [k, v] of refreshed.bySummary) bySummary.set(k, v);
      log(`After dedupe: ${bySummary.size} unique test case(s) remain.`);
    }
  }

  const names = [...groups.keys()];
  const toCreate = names.filter((n) => !bySummary.has(n));
  const toReuse = names.filter((n) => bySummary.has(n));
  log(`Plan: ${toCreate.length} to create, ${toReuse.length} to reuse, ${names.length} total.`);

  if (dryRun) {
    log('dryRun: no changes will be made.');
    return {
      dryRun: true,
      csvPath,
      resultsCsvPath: resolveResultsCsvPath(storyKey),
      total: names.length,
      toCreate: toCreate.length,
      toReuse: toReuse.length,
      createdCount: toCreate.length,
      reusedCount: toReuse.length,
      preExistingDuplicates: duplicates.map((d) => d.key),
      rows: names.map((name) => {
        const existingTc = bySummary.get(name);
        const groupRows = groups.get(name);
        return {
          test_case_name: name,
          priority: mapCsvPriorityToName(groupRows[0]?.priority) || '',
          jira_issue_key: existingTc?.key || '(would be created)',
          jira_issue_id: existingTc?.id ?? '',
          agiletest_testcase_id: '',
        };
      }),
      durationMs: timer.elapsedMs(),
    };
  }

  const created = new Map();
  const failures = [];

  // Re-check immediately before creating. The lock only serialises runs that
  // share a checkout, so on separate checkouts two users can both observe "not
  // found" at the top of the phase. This narrows that window: if a peer created
  // the issue while this run was starting up, the existing one is reused instead
  // of a second copy being made.
  let latest = existing;
  if (toCreate.length) {
    try {
      latest = await findLinkedTestCasesBySummary({ storyKey });
      const appeared = toCreate.filter((n) => latest.bySummary.has(n));
      if (appeared.length) {
        log(
          `Re-check: ${appeared.length} test case(s) now exist (created by a concurrent run) and will be reused: ` +
            appeared.join(', '),
        );
        for (const name of appeared) bySummary.set(name, latest.bySummary.get(name));
        toReuse.push(...appeared);
        for (const name of appeared) {
          const i = toCreate.indexOf(name);
          if (i >= 0) toCreate.splice(i, 1);
        }
      }
    } catch (err) {
      log(`WARNING: pre-create re-check failed (${err?.message || err}); continuing with the earlier lookup.`);
    }
  }

  await mapWithConcurrency(toCreate, concurrency, async (name) => {
    const groupRows = groups.get(name);
    try {
      const result = await createJiraTestCase({
        summary: name,
        description: (groupRows[0]?.description || '').trim(),
        storyKey,
        priorityName: mapCsvPriorityToName(groupRows[0]?.priority),
      });
      created.set(name, result);
      log(`created ${result.key} (id ${result.id}) - ${name}`);
    } catch (err) {
      failures.push({ name, error: err?.response?.data || err?.message || String(err) });
      log(`FAILED to create ${name}: ${err?.response?.status || ''} ${err?.message || err}`);
    }
  });

  // Assignment: newly created issues are always assigned, and reused issues are
  // only assigned when a single bulk lookup shows a different assignee. The
  // previous per-issue GET cost one round trip per reused test case.
  const assignTargets = [...created.keys()].concat(toReuse);
  if (assignTargets.length && assigneeAccountId) {
    const needsAssign = new Set([...created.keys()]);

    const reuseIds = toReuse
      .map((name) => bySummary.get(name))
      .filter(Boolean)
      .map((tc) => tc.id || tc.key)
      .filter(Boolean);

    if (reuseIds.length) {
      try {
        const bulk = await getJiraIssuesBulk({ ids: reuseIds, fields: ['summary', 'assignee'] });
        for (const name of toReuse) {
          const tc = bySummary.get(name);
          if (!tc) continue;
          const info = bulk.get(String(tc.id));
          if (info && info.assigneeAccountId !== assigneeAccountId) needsAssign.add(name);
        }
      } catch (err) {
        log(
          `WARNING: bulk assignee lookup failed (${err?.response?.status || ''} ${err?.message || err}); ` +
            `falling back to assigning every reused test case.`,
        );
        for (const name of toReuse) needsAssign.add(name);
      }
    }

    if (needsAssign.size) {
      await mapWithConcurrency([...needsAssign], concurrency, async (name) => {
        const tc = created.get(name) || bySummary.get(name);
        if (!tc) return;
        try {
          await assignJiraIssue({ issueIdOrKey: tc.key, accountId: assigneeAccountId });
        } catch (err) {
          log(`WARNING: failed to assign ${tc.key}: ${err?.message || err}`);
        }
      });
    }
    log(`Assignment checked for ${assignTargets.length} test case(s); ${needsAssign.size} needed a change.`);
  }

  const rows = names.map((name) => {
    const groupRows = groups.get(name);
    const tc = created.get(name) || bySummary.get(name);
    return {
      test_case_name: name,
      priority: mapCsvPriorityToName(groupRows[0]?.priority) || '',
      jira_issue_key: tc?.key || '',
      jira_issue_id: tc?.id ?? '',
      agiletest_testcase_id: '',
    };
  });

  const resultsCsvPath = resolveResultsCsvPath(storyKey);

  // Carry over any AgileTest ids already recorded for these same test cases.
  // The Jira phase runs before the AgileTest phase, so without this a run that
  // later fails would leave the results CSV with every agiletest_testcase_id
  // blank, losing IDs that are still perfectly valid in AgileTest.
  const previousAtByName = new Map();
  try {
    if (fs.existsSync(resultsCsvPath)) {
      for (const prev of parseCsv(resultsCsvPath).rows) {
        const name = (prev.test_case_name || '').trim();
        const at = (prev.agiletest_testcase_id || '').trim();
        if (name && at) previousAtByName.set(name, at);
      }
    }
  } catch (err) {
    log(`Note: could not read existing results CSV to preserve AgileTest ids (${err?.message || err}).`);
  }
  for (const row of rows) {
    if (!row.agiletest_testcase_id && previousAtByName.has(row.test_case_name)) {
      row.agiletest_testcase_id = previousAtByName.get(row.test_case_name);
    }
  }

  writeResultsCsv(resultsCsvPath, rows);
  log(`Wrote ${rows.length} rows to ${resultsCsvPath}`);

  return {
    dryRun: false,
    csvPath,
    resultsCsvPath,
    rows,
    createdCount: created.size,
    reusedCount: toReuse.length,
    failures,
    dedupe,
    preExistingDuplicates: duplicates.map((d) => d.key),
    expectedType: EXPECTED_TYPE,
    durationMs: timer.elapsedMs(),
  };
}
