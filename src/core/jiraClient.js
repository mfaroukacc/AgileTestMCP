import axios from 'axios';
import dotenv from 'dotenv';
import { assertFreshCode } from './pipeline/fingerprint.js';
import { ENV_FILE } from './paths.js';

// Absolute path, not the default. dotenv resolves its default against
// process.cwd(), which is the user's home folder when an MCP client spawns this
// process, so the load silently no-ops and every variable below stays undefined.
dotenv.config({ path: ENV_FILE });

// These are read once, at import time. Anything that sets the environment later
// (a later dotenv load, a test harness) cannot affect them, which is why .env
// must be loaded above and why the import order in mcp/server.js matters.
const {
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY,
  JIRA_TESTCASE_ISSUETYPE_NAME,
  JIRA_ASSIGNEE_ACCOUNT_ID,
  JIRA_ISSUE_LINK_TYPE,
  JIRA_TESTCASE_PRIORITY_NAME,
} = process.env;

if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_PROJECT_KEY) {
  console.warn('[jiraClient] Missing one or more Jira env vars (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY).');
}

export function getJiraHttpClient() {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('Jira environment variables are not fully configured');
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  return axios.create({
    baseURL: JIRA_BASE_URL,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  });
}

export async function linkJiraIssues({ storyKey, testCaseKey }) {
  const client = getJiraHttpClient();

  const linkTypeName = JIRA_ISSUE_LINK_TYPE || 'AgileTest';

  const body = {
    type: {
      name: linkTypeName,
    },
    // Make the Test Case the inward issue and the Story the outward issue
    // so that on the Story you see the "Tests" side of the link.
    inwardIssue: { key: testCaseKey },
    outwardIssue: { key: storyKey },
  };

  await client.post('/rest/api/3/issueLink', body);
}

export async function assignJiraIssue({ issueIdOrKey, accountId }) {
  const client = getJiraHttpClient();

  const body = {
    accountId,
  };

  await client.put(`/rest/api/3/issue/${issueIdOrKey}/assignee`, body);
}

export async function getJiraIssue(issueIdOrKey) {
  const client = getJiraHttpClient();
  const { data } = await client.get(`/rest/api/3/issue/${issueIdOrKey}`);
  return data;
}

export async function findLinkedTestCases({ storyKey }) {
  const client = getJiraHttpClient();

  const { data } = await client.get(
    `/rest/api/2/issue/${encodeURIComponent(storyKey)}?fields=issuelinks,summary`,
  );

  const linkTypeName = JIRA_ISSUE_LINK_TYPE || 'AgileTest';
  const found = [];

  for (const link of data?.fields?.issuelinks || []) {
    // Test Case is created as the inwardIssue of an is-Jira-link with the Story as outwardIssue,
    // so existing TestCases for the Story appear in story.issuelinks[].inwardIssue.
    const linked = link?.inwardIssue;
    if (link?.type?.name === linkTypeName && linked?.key) {
      found.push({
        key: linked.key,
        id: linked.id,
        summary: linked.fields?.summary ?? '',
      });
    }
  }

  return found;
}

// Index linked test cases by summary, always keeping the lowest issue id for a
// given summary. Callers use this to reuse instead of create. If the same
// summary is linked more than once (which is what a previously duplicated run
// leaves behind), the extras are reported so they can be surfaced.
export async function findLinkedTestCasesBySummary({ storyKey }) {
  const linked = await findLinkedTestCases({ storyKey });

  const bySummary = new Map();
  const duplicates = [];

  for (const tc of linked) {
    if (!tc.summary) continue;
    const existing = bySummary.get(tc.summary);
    if (!existing) {
      bySummary.set(tc.summary, tc);
    } else {
      if (Number(tc.id) < Number(existing.id)) {
        bySummary.set(tc.summary, tc);
        duplicates.push(existing);
      } else {
        duplicates.push(tc);
      }
    }
  }

  return { bySummary, duplicates, total: linked.length };
}

// Fetch the assignee of an issue without failing the caller.
export async function getJiraIssueAssignee({ issueIdOrKey }) {
  const client = getJiraHttpClient();
  const { data } = await client.get(`/rest/api/3/issue/${encodeURIComponent(issueIdOrKey)}?fields=assignee`);
  return data?.fields?.assignee?.accountId ?? null;
}

// Fetch key, id, summary, assignee and issue type for many issues in one
// request instead of one GET per issue.
//
// NOTE: this Jira instance returns 403 for GET /rest/api/3/search and GET
// /rest/api/2/search, and 410 for the old GET /rest/api/3/search. The working
// route is POST /rest/api/3/search/jql with a JSON body, so that is what is
// used here. Jira caps the JQL `id in (...)` clause, so this is chunked.
export async function getJiraIssuesBulk({ ids, fields = ['summary', 'assignee'] }) {
  const client = getJiraHttpClient();
  const wanted = [...new Set(ids.map(String).filter(Boolean))];
  if (!wanted.length) return new Map();

  const out = new Map();
  const CHUNK = 50;

  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const jql = `id in (${chunk.join(',')})`;
    const { data } = await client.post('/rest/api/3/search/jql', {
      jql,
      fields,
      maxResults: chunk.length,
    });
    for (const issue of data?.issues || []) {
      out.set(String(issue.id), {
        key: issue.key,
        id: String(issue.id),
        summary: issue.fields?.summary ?? '',
        assigneeAccountId: issue.fields?.assignee?.accountId ?? null,
        issuetype: issue.fields?.issuetype?.name ?? null,
      });
    }
  }

  return out;
}

// Delete Jira test cases by key/id, verifying the issue type first so a Story or
// Bug can never be deleted by mistake. Only ids listed in `ids` are touched.
export async function deleteJiraTestCasesByIds({ ids, log = () => {} }) {
  const expectedType = JIRA_TESTCASE_ISSUETYPE_NAME || 'Test Case';
  const wanted = [...new Set(ids.map(String).filter(Boolean))];
  const results = [];
  if (!wanted.length) return results;

  // This is the only irreversible operation in the system, so the guard lives
  // here rather than at each caller: any future caller inherits it. A process
  // running superseded code must not be trusted to choose what to delete.
  assertFreshCode({ context: `deleting ${wanted.length} Jira issue(s)` });

  const client = getJiraHttpClient();

  // One lookup gives us the type check for every candidate.
  let typeById = new Map();
  try {
    typeById = await getJiraIssuesBulk({ ids: wanted, fields: ['issuetype'] });
  } catch (err) {
    log(`[dedupe] Bulk type lookup failed, falling back to per-issue checks: ${err?.message || err}`);
  }

  for (const id of wanted) {
    try {
      let issueType = typeById.get(id)?.issuetype;
      if (!issueType) {
        const { data } = await client.get(
          `/rest/api/3/issue/${encodeURIComponent(id)}?fields=issuetype`,
        );
        issueType = data?.fields?.issuetype?.name;
      }

      if (issueType !== expectedType) {
        results.push({ id, deleted: false, reason: `issuetype is "${issueType}", expected "${expectedType}"` });
        continue;
      }

      await client.delete(`/rest/api/3/issue/${encodeURIComponent(id)}`);
      results.push({ id, deleted: true });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) {
        results.push({ id, deleted: false, reason: 'not found' });
      } else if (status === 403) {
        results.push({ id, deleted: false, reason: 'no delete permission' });
      } else {
        results.push({
          id,
          deleted: false,
          reason: err?.response?.data?.errorMessages?.join(' | ') || err?.message || String(err),
        });
      }
    }
  }

  return results;
}

export async function createJiraTestCase({ summary, description, storyKey, priorityName }) {
  const client = getJiraHttpClient();

  const issuetypeName = JIRA_TESTCASE_ISSUETYPE_NAME || 'Test Case';

  const effectivePriorityName = priorityName || JIRA_TESTCASE_PRIORITY_NAME;

  const priorityField =
    effectivePriorityName
      ? { priority: { name: effectivePriorityName } }
      : {};

  const body = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      summary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: description },
            ],
          },
        ],
      },
      issuetype: {
        name: issuetypeName,
      },
      ...priorityField,
    },
  };

  const { data } = await client.post('/rest/api/3/issue', body);

  const { key, id } = data;

  if (storyKey) {
    await linkJiraIssues({ storyKey, testCaseKey: key });
  }

  return { key, id };
}
