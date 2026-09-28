import { findLinkedTestCasesBySummary, deleteJiraTestCasesByIds } from '../jiraClient.js';
import { createTimer } from './concurrency.js';
import { assertFreshCode } from './fingerprint.js';

// Remove duplicate Jira test cases that are linked to a story with the same
// summary, keeping one survivor per summary (the lowest issue id, which is the
// one already referenced by the results CSV and by AgileTest).
//
// Safety rules, all deliberate:
//   - only test cases of the configured issue type are ever deleted
//   - only issues currently linked to the story are considered
//   - one survivor is always kept per summary, so a run can never end up with
//     zero test cases for a CSV row
//   - a dry run reports exactly what would be deleted and changes nothing
export async function dedupeStory({
  storyKey,
  dryRun = true,
  log = () => {},
}) {
  const timer = createTimer();

  // Deleting the wrong test cases is unrecoverable, so a process running
  // superseded code must not be trusted to pick the right ones. Only enforced
  // when this will actually delete; a dry run changes nothing.
  if (!dryRun) assertFreshCode({ context: `dedupe of ${storyKey}` });

  const { bySummary, duplicates, total } = await findLinkedTestCasesBySummary({ storyKey });

  if (!duplicates.length) {
    log(`No duplicate test cases on ${storyKey} (${total} linked, all unique).`);
    return {
      storyKey,
      dryRun,
      total,
      duplicatesFound: 0,
      deleted: [],
      kept: [...bySummary.values()].map((t) => t.key),
      durationMs: timer.elapsedMs(),
    };
  }

  const toDelete = duplicates.map((d) => ({ key: d.key, id: d.id, summary: d.summary }));

  log(
    `${storyKey}: ${total} linked test case(s), ${toDelete.length} duplicate(s). ` +
      `Keeping the lowest id per summary.`,
  );
  for (const d of toDelete) {
    log(`  would delete ${d.key} (duplicate of "${d.summary}")`);
  }

  if (dryRun) {
    log('dryRun: nothing deleted.');
    return {
      storyKey,
      dryRun,
      total,
      duplicatesFound: toDelete.length,
      wouldDelete: toDelete,
      kept: [...bySummary.values()].map((t) => t.key),
      durationMs: timer.elapsedMs(),
    };
  }

  const results = await deleteJiraTestCasesByIds({
    ids: toDelete.map((d) => d.id || d.key),
    log,
  });

  const deleted = results.filter((r) => r.deleted).map((r) => r.id);
  const failed = results.filter((r) => !r.deleted);

  log(`Deleted ${deleted.length} duplicate test case(s) from ${storyKey}.`);
  for (const f of failed) {
    log(`  WARNING: could not delete ${f.id}: ${f.reason}`);
  }

  return {
    storyKey,
    dryRun,
    total,
    duplicatesFound: toDelete.length,
    deleted,
    failed,
    kept: [...bySummary.values()].map((t) => t.key),
    durationMs: timer.elapsedMs(),
  };
}
