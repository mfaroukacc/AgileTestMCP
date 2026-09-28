import axios from 'axios';
import dotenv from 'dotenv';
import { ENV_FILE } from './paths.js';

// Absolute path, not the default. dotenv resolves its default against
// process.cwd(), which is the user's home folder when an MCP client spawns this
// process, so the load silently no-ops and the credentials below stay undefined.
dotenv.config({ path: ENV_FILE });

const AGILETEST_BASE = 'https://agiletest.atlas.devsamurai.com';

let cachedJwt = null;
let cachedJwtExpiresAt = 0;
const JWT_REFRESH_MARGIN_MS = 2 * 60 * 1000;

// This AgileTest instance intermittently answers with a generic 5xx body such as
// "Some error occurred while authenticate api key." or "Some error occurred while
// getting the test cases." Those are transient, so they are retried with a short
// backoff instead of failing the whole pipeline.
const TRANSIENT_MAX_ATTEMPTS = 5;
const TRANSIENT_BASE_DELAY_MS = 1000;
const TRANSIENT_MESSAGES = [
  'some error occurred while authenticate api key',
  'some error occurred while getting the test cases',
  'some error occurred while create and link precondition',
  'econnreset',
  'etimedout',
  'socket hang up',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransientAgileTestError(err) {
  const status = err?.response?.status;
  if (status && status >= 500) return true;
  if (status === 429) return true;
  // Some failures arrive as HTTP 200 with a generic message body.
  const data = err?.response?.data;
  const message = String(
    (data && typeof data === 'object' && (data.message || data.error)) || data || err?.message || '',
  ).toLowerCase();
  return TRANSIENT_MESSAGES.some((m) => message.includes(m));
}

export async function withAgileTestRetry(label, fn, { maxAttempts = TRANSIENT_MAX_ATTEMPTS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientAgileTestError(err) || attempt === maxAttempts) throw err;
      const delay = TRANSIENT_BASE_DELAY_MS * attempt;
      console.warn(
        `[agiletestClient] ${label} hit a transient error (attempt ${attempt}/${maxAttempts}), ` +
          `retrying in ${delay}ms: ${err?.response?.data?.message || err?.message || err}`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

const { AGILETEST_CLIENT_ID, AGILETEST_CLIENT_SECRET } = process.env;

if (!AGILETEST_CLIENT_ID || !AGILETEST_CLIENT_SECRET) {
  console.warn('[agiletestClient] Missing AGILETEST_CLIENT_ID or AGILETEST_CLIENT_SECRET in .env');
}

export async function getAgileTestJwt() {
  if (!AGILETEST_CLIENT_ID || !AGILETEST_CLIENT_SECRET) {
    throw new Error('AGILETEST_CLIENT_ID and AGILETEST_CLIENT_SECRET must be set in .env');
  }

  // Cache the token so a long pipeline run authenticates once instead of per call.
  const now = Date.now();
  if (cachedJwt && cachedJwtExpiresAt - now > JWT_REFRESH_MARGIN_MS) {
    return cachedJwt;
  }

  const url = `${AGILETEST_BASE}/api/apikeys/authenticate`;
  const body = {
    clientId: AGILETEST_CLIENT_ID,
    clientSecret: AGILETEST_CLIENT_SECRET,
  };

  const data = await withAgileTestRetry('authenticate', () =>
    axios.post(url, body, { headers: { 'Content-Type': 'application/json' } }),
  ).then((r) => r.data);

  // API returns the JWT as a raw string, not an object
  if (!data || typeof data !== 'string') {
    throw new Error('Unexpected response from AgileTest authenticate API: expected raw token string');
  }

  const token = data.trim();
  cachedJwt = token;

  // The token itself is a JWT, so we can read its exp instead of re-authenticating blindly.
  const exp = decodeJwtExp(token);
  cachedJwtExpiresAt = exp ? exp * 1000 : now + 10 * 60 * 1000;

  return token;
}

export function clearAgileTestJwtCache() {
  cachedJwt = null;
  cachedJwtExpiresAt = 0;
}

function decodeJwtExp(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    // JWT payloads are base64url ("-" and "_"), which is not valid base64.
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const exp = JSON.parse(json)?.exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

// Runs fn with a valid token, re-authenticating and retrying once if the token
// expired mid-run. Long runs previously died with a bare 401.
export async function withAgileTestAuth(fn) {
  let token = await getAgileTestJwt();
  try {
    return await fn(token);
  } catch (err) {
    if (err?.response?.status !== 401) throw err;
    console.warn('[agiletestClient] Token rejected (401); re-authenticating and retrying once.');
    clearAgileTestJwtCache();
    token = await getAgileTestJwt();
    return fn(token);
  }
}

// This function was originally used with /ds/test-cases/bulk using Jira issue KEYS.
// We keep it for backwards compatibility, but for numeric Jira issue IDs we now use
// createAgileTestTestCasesFromIssueIds below.
export async function createAgileTestTestCase(jwtToken, { projectId, summary, description, jiraIssueKey }) {
  const url = `${AGILETEST_BASE}/ds/test-cases/bulk`;

  const payload = {
    projectId,
    tests: [
      {
        name: summary,
        description,
        issueKey: jiraIssueKey,
      },
    ],
  };

  const { data } = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `JWT ${jwtToken}`,
    },
  });

  if (!data || !Array.isArray(data.tests) || data.tests.length === 0) {
    throw new Error('Unexpected response from AgileTest create test case API');
  }

  const created = data.tests[0];
  return created;
}

// New helper: create AgileTest test cases from numeric Jira issue IDs via /ds/test-cases/bulk
export async function createAgileTestTestCasesFromIssueIds(jwtToken, { projectId, folderId = 0, testCaseIssueIds }) {
  const url = `${AGILETEST_BASE}/ds/test-cases/bulk`;

  const payload = {
    projectId: String(projectId),
    folderId,
    testCaseIssueIds: testCaseIssueIds.map(String),
  };

  const attemptCreate = async (tokenToUse) => {
    const { data } = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `JWT ${tokenToUse}`,
      },
    });

    return data;
  };

  try {
    // First attempt with the provided JWT
    return await attemptCreate(jwtToken);
  } catch (err) {
    // If AgileTest returns "Some Test Case work item(s) was not found", re-authenticate
    // and retry once with a fresh JWT for the same Jira issue id(s).
    const raw = err?.response?.data;
    let messageText = '';

    if (raw) {
      if (typeof raw === 'string') {
        messageText = raw;
      } else if (typeof raw === 'object') {
        if (typeof raw.message === 'string') {
          messageText = raw.message;
        } else if (Array.isArray(raw.errors)) {
          messageText = raw.errors
            .map((e) => (typeof e === 'string' ? e : e?.message || ''))
            .join(' | ');
        } else {
          try {
            messageText = JSON.stringify(raw);
          } catch (jsonErr) {
            messageText = String(raw);
          }
        }
      }
    } else if (err?.message) {
      messageText = err.message;
    } else {
      messageText = String(err);
    }

    const shouldRetry =
      typeof messageText === 'string' &&
      messageText.includes('Some Test Case work item(s) was not found');

    if (!shouldRetry) {
      throw err;
    }

    console.warn(
      '[agiletestClient] AgileTest bulk create returned "Some Test Case work item(s) was not found". ' +
        'Re-authenticating and retrying once for Jira issue id(s):',
      payload.testCaseIssueIds,
    );

    const freshJwt = await getAgileTestJwt();

    try {
      return await attemptCreate(freshJwt);
    } catch (retryErr) {
      console.error(
        '[agiletestClient] Retry after re-authentication also failed:',
        retryErr?.response?.data || retryErr.message || retryErr,
      );
      // Re-throw the original error so callers can see the initial failure.
      throw err;
    }
  }
}

// Retrieve AgileTest test case(s) for one or more Jira issue ids.
// We'll use this to find the AgileTest testCaseId created from a Jira TestCase issue.
export async function getAgileTestTestcaseByJiraIssueId(
  jwtToken,
  { projectId, jiraIssueId }
) {
  const url = `${AGILETEST_BASE}/ds/test-cases/issue/bulk`;

  const payload = {
    projectId: String(projectId),
    issueIds: [String(jiraIssueId)],
    expand: [],
  };

  const { data } = await axios.post(url, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `JWT ${jwtToken}`,
    },
  });

  let testCases;
  if (Array.isArray(data)) {
    testCases = data;
  } else if (Array.isArray(data.testCases)) {
    testCases = data.testCases;
  } else {
    throw new Error('Unexpected response from AgileTest /ds/test-cases/issue/bulk API');
  }

  if (!testCases.length) {
    throw new Error(`No AgileTest test cases found for Jira issue id ${jiraIssueId}`);
  }

  return testCases[0];
}

// Bulk lookup: retrieve AgileTest test cases for multiple Jira issue ids in one call.
// Returns an array of test case objects as provided by AgileTest.
export async function getAgileTestTestcasesByJiraIssueIds(
  jwtToken,
  { projectId, jiraIssueIds, expand = [] }
) {
  const url = `${AGILETEST_BASE}/ds/test-cases/issue/bulk`;

  const payload = {
    projectId: String(projectId),
    issueIds: jiraIssueIds.map((id) => String(id)),
    expand,
  };

  const { data } = await withAgileTestRetry('bulk test case lookup', () =>
    axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `JWT ${jwtToken}`,
      },
    }),
  );

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.testCases)) {
    return data.testCases;
  }

  // A 200 response carrying a generic error message is one of this instance's
  // transient failures, so it is retried rather than treated as a bad payload.
  if (data && (data.message || data.error)) {
    const transient = new Error(
      `AgileTest bulk lookup returned an error: ${data.message || data.error}`,
    );
    transient.response = { status: 500, data };
    throw transient;
  }

  throw new Error('Unexpected response from AgileTest /ds/test-cases/issue/bulk API (bulk lookup)');
}

// Provide a camel-cased alias for historical imports that expect
// `getAgileTestTestCaseByJiraIssueId` (capital C in "Case").
export { getAgileTestTestcaseByJiraIssueId as getAgileTestTestCaseByJiraIssueId };

export async function createAgileTestTestStep(
  jwtToken,
  { projectId, testCaseId, action, expectedResult, dataField = '', stepIndex = 0 }
) {
  const url = `${AGILETEST_BASE}/ds/test-steps`;

  const payload = {
    testCaseId: Number(testCaseId),
    action,
    data: dataField,
    expectedResult,
    details: {},
    stepIndex,
    projectId: String(projectId),
  };

  const { data } = await withAgileTestRetry('create test step', () =>
    axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `JWT ${jwtToken}`,
      },
    }),
  );

  return data;
}

// Create or update a precondition for a given test case
// Create a precondition linked to a test case.
// NOTE: this endpoint is CREATE-ONLY. Calling it when the test case already has
// a precondition fails with "Some error occurred while create and link
// precondition to test case.", which is what aborted earlier runs. Use
// updateAgileTestPrecondition (PUT) to change existing text instead.
export async function createAgileTestPrecondition(jwtToken, { testCaseId, body }) {
  const url = `${AGILETEST_BASE}/ds/test-cases/${Number(testCaseId)}/precondition`;

  const { data } = await withAgileTestRetry('create precondition', () =>
    axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `JWT ${jwtToken}`,
      },
    }),
  );

  return data;
}

// Update an existing precondition's text.
// NOTE: unlike create, this endpoint takes a FLAT body ({ projectId, title,
// details }); sending the nested create-style body returns 200 but silently
// discards the change.
export async function updateAgileTestPrecondition(jwtToken, { preconditionId, projectId, title, details }) {
  const url = `${AGILETEST_BASE}/ds/preconditions/${Number(preconditionId)}?projectId=${encodeURIComponent(projectId)}`;

  const { data } = await withAgileTestRetry('update precondition', () =>
    axios.put(
      url,
      { projectId: String(projectId), title, details },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `JWT ${jwtToken}`,
        },
      },
    ),
  );

  return data;
}

// Delete a single AgileTest test step.
// NOTE: projectId is a REQUIRED query param on this endpoint; omitting it returns 400.
export async function deleteAgileTestTestStep(jwtToken, { projectId, stepId }) {
  const url = `${AGILETEST_BASE}/ds/test-steps/${Number(stepId)}?projectId=${encodeURIComponent(projectId)}`;

  await withAgileTestRetry('delete test step', () =>
    axios.delete(url, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `JWT ${jwtToken}`,
      },
    }),
  );
}

// Fetch existing steps for the AgileTest test case mapped to a Jira issue id.
// NOTE: there is no GET /ds/test-steps endpoint (404) and GET /ds/test-cases/{id}
// returns 400, so the only working read path is /ds/test-cases/issue/bulk with
// expand: ['testSteps'], which is keyed by Jira issue id rather than testCaseId.
export async function getAgileTestTestSteps(jwtToken, { projectId, jiraIssueId }) {
  const [testCase] = await getAgileTestTestcasesByJiraIssueIds(jwtToken, {
    projectId,
    jiraIssueIds: [String(jiraIssueId)],
    expand: ['testSteps'],
  });
  return testCase?.testSteps || [];
}

// Delete an AgileTest test case by its AgileTest testCaseId.
// UNSUPPORTED: verified against this AgileTest instance (2026-09-28) - every
// DELETE shape on /ds/test-cases returns 404, and deleting the source Jira
// issue does not cascade. Orphaned AgileTest test cases must be removed by hand
// in the AgileTest UI. Kept only so callers get a clear error instead of a
// silent no-op.
export async function deleteAgileTestTestCase() {
  const err = new Error(
    'The AgileTest API does not expose a delete route for test cases. ' +
      'Delete the test case in the AgileTest UI instead.',
  );
  err.code = 'EUNSUPPORTED';
  throw err;
}
