import fs from 'fs';
import path from 'path';
import { GENERATED_DIR, RESULTS_DIR } from '../paths.js';

export const REQUIRED_COLUMNS = [
  'test_case_name',
  'description',
  'priority',
  'precondition',
  'step_number',
  'action',
  'expected_result',
];

export const RESULTS_HEADER =
  'test_case_name,priority,jira_issue_key,jira_issue_id,agiletest_testcase_id';

export function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return { header: [], rows: [] };

  const header = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cols.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cols.push(current);

    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = (cols[idx] ?? '').replace(/^"|"$/g, '');
    });
    return obj;
  });

  return { header, rows };
}

function escapeCell(value) {
  const str = value == null ? '' : String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function serializeResultsRow(row) {
  return [
    row.test_case_name,
    row.priority,
    row.jira_issue_key,
    row.jira_issue_id ?? '',
    row.agiletest_testcase_id ?? '',
  ]
    .map(escapeCell)
    .join(',');
}

// Results rows are written in Jira key order so the file reads predictably
// (SHP-4491, SHP-4492, ...). Test cases are created in generated-CSV order, but
// the CSV can be regenerated and reordered afterwards, and earlier rows are
// reused by summary rather than recreated, so creation order and CSV order drift
// apart. Sorting here - the single write path used by both the Jira and the
// AgileTest phase - keeps the two phases from undoing each other.
function jiraKeyOrder(a, b) {
  const keyA = a.jira_issue_key || '';
  const keyB = b.jira_issue_key || '';
  // Rows with no Jira key yet (a create that has not been written back) sort
  // last so the assigned rows stay at the top of the file.
  if (!keyA !== !keyB) return keyA ? -1 : 1;
  if (keyA !== keyB) {
    // Compare the project prefix textually and the numeric suffix numerically,
    // so SHP-9999 sorts before SHP-10000.
    const mA = keyA.match(/^(.*?)(\d+)$/);
    const mB = keyB.match(/^(.*?)(\d+)$/);
    if (mA && mB && mA[1] === mB[1]) {
      return Number(mA[2]) - Number(mB[2]);
    }
    return keyA < keyB ? -1 : 1;
  }
  // Same key (or both missing): fall back to the numeric issue id, then keep
  // the existing order stable.
  return (Number(a.jira_issue_id) || 0) - (Number(b.jira_issue_id) || 0);
}

export function writeResultsCsv(resultsPath, rows) {
  const dir = path.dirname(resultsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ordered = [...rows].sort(jiraKeyOrder);
  fs.writeFileSync(
    resultsPath,
    `${[RESULTS_HEADER, ...ordered.map(serializeResultsRow)].join('\n')}\n`,
    'utf8',
  );
}

// The Jira phase and the AgileTest phase historically disagreed about whether
// the CSV lives in Generated_Test_Cases/ or Generated_Test_Cases/Signals/.
// Resolve both, preferring Signals/, then fall back to any feature subfolder
// (SuccessStories/, Entities/, ...) so the folder the generator picked does not
// decide whether a story can be pushed. Report which one was used.
export function resolveGeneratedCsvPath(storyKey, { required = true } = {}) {
  const filename = `${storyKey}_testcases_generated.csv`;

  let subdirs = [];
  try {
    subdirs = fs
      .readdirSync(GENERATED_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(GENERATED_DIR, e.name));
  } catch {
    subdirs = [];
  }

  const candidates = [
    ...new Set([
      path.join(GENERATED_DIR, 'Signals', filename),
      path.join(GENERATED_DIR, filename),
      ...subdirs.map((d) => path.join(d, filename)),
    ]),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  if (!required) return null;
  const err = new Error(
    `Generated test cases CSV not found for ${storyKey}. Looked in:\n` +
      candidates.map((c) => `  - ${c}`).join('\n') +
      `\nExport it from AgileTest ("Export Test Cases to CSV") or place it in Generated_Test_Cases/.`,
  );
  err.code = 'ECSVNOTFOUND';
  throw err;
}

export function resolveResultsCsvPath(storyKey) {
  return path.join(RESULTS_DIR, `${storyKey}_testcases_results.csv`);
}

// Runs before any write happens, so a malformed CSV can never leave a story
// half-populated.
export function preflightGeneratedCsv(csvPath) {
  const { header, rows } = parseCsv(csvPath);
  const problems = [];

  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    problems.push(`Missing required column(s): ${missing.join(', ')}. Found: ${header.join(', ')}.`);
  }

  if (!rows.length) problems.push('CSV has a header but no data rows.');

  const groups = groupByTestCase(rows);
  const seenSteps = new Map();

  for (const [name, groupRows] of groups) {
    for (const r of groupRows) {
      const stepNo = Number(r.step_number);
      const key = `${name}::${r.step_number}`;
      if (!stepNo || Number.isNaN(stepNo)) {
        problems.push(`Test case "${name}" has an invalid step_number: "${r.step_number}".`);
        continue;
      }
      if (seenSteps.has(key)) {
        problems.push(
          `Test case "${name}" has duplicate step_number ${stepNo} ` +
            `(rows ${seenSteps.get(key) + 2} and ${rows.indexOf(r) + 2}).`,
        );
      } else {
        seenSteps.set(key, rows.indexOf(r));
      }
      if (!String(r.action || '').trim() && !String(r.expected_result || '').trim()) {
        problems.push(
          `Test case "${name}" step ${stepNo} has both action and expected_result empty.`,
        );
      }
    }
  }

  if (problems.length) {
    const err = new Error(
      `Preflight failed for ${csvPath} - no changes were made:\n  - ${problems.slice(0, 20).join('\n  - ')}` +
        (problems.length > 20 ? `\n  ...and ${problems.length - 20} more` : ''),
    );
    err.code = 'EPREFLIGHT';
    throw err;
  }

  return { header, rows, groups };
}

export function groupByTestCase(rows) {
  const groups = new Map();
  for (const row of rows) {
    const name = (row.test_case_name || '').trim();
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  for (const [, groupRows] of groups) {
    groupRows.sort((a, b) => Number(a.step_number) - Number(b.step_number));
  }
  return groups;
}

// Parse CSV content provided as a raw string (used by the LLM generation path)
export function parseCsvString(raw) {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return { header: [], rows: [] };

  const header = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cols = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cols.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    cols.push(current);

    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = (cols[idx] ?? '').replace(/^"|"$/g, '');
    });
    return obj;
  });

  return { header, rows };
}
