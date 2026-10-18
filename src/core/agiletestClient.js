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

// Shared normaliser for the */issue/bulk endpoints, which answer with a bare
// array on some paths and an object wrapper on others. An error body arriving
// with HTTP 200 is rethrown as a transient error so withAgileTestRetry backs off
// instead of the caller treating it as a found entity.
function toEntityList(data, { label, listKeys }) {
  if (Array.isArray(data)) return data;

  if (data && typeof data === 'object') {
    for (const key of listKeys) {
      if (Array.isArray(data[key])) return data[key];
    }
    if (data.id != null) return [data];

    if (data.message || data.error) {
      const transient = new Error(`AgileTest ${label} returned an error: ${data.message || data.error}`);
      transient.response = { status: 500, data };
      throw transient;
    }
  }

  throw new Error(`Unexpected response from AgileTest ${label} API`);
}

const authHeaders = (jwtToken) => ({
  'Content-Type': 'application/json',
  Authorization: `JWT ${jwtToken}`,
});

// ---------------------------------------------------------------------------
// Test executions
// ---------------------------------------------------------------------------

// Create AgileTest Test Execution(s) from Jira Test Execution issue id(s).
export async function createAgileTestExecution(jwtToken, { projectId, testExecutionIssueIds }) {
  const url = `${AGILETEST_BASE}/ds/test-executions`;
  const payload = {
    projectId: String(projectId),
    testExecutionIssueIds: testExecutionIssueIds.map(String),
  };

  const { data } = await withAgileTestRetry('create test execution', () =>
    axios.post(url, payload, { headers: authHeaders(jwtToken) }),
  );

  return data;
}

// Resolve AgileTest Test Execution(s) from Jira Test Execution issue id(s).
// The AgileTest execution id needed for later link/list calls comes from here.
export async function getAgileTestExecutionsByJiraIssueIds(jwtToken, { projectId, testExecutionIssueIds }) {
  const url = `${AGILETEST_BASE}/ds/test-executions/issue/bulk`;
  const payload = {
    projectId: String(projectId),
    issueIds: testExecutionIssueIds.map(String),
    testExecutionIssueIds: testExecutionIssueIds.map(String),
    expand: [],
  };

  const { data } = await withAgileTestRetry('test execution lookup', () =>
    axios.post(url, payload, { headers: authHeaders(jwtToken) }),
  );

  return toEntityList(data, { label: '/ds/test-executions/issue/bulk', listKeys: ['executions', 'testExecutions'] });
}

// List the AgileTest test cases linked to an AgileTest Test Execution, each with
// its testExecutionItems (result status ids) for pass/fail filtering.
export async function getAgileTestExecutionTestCases(jwtToken, { projectId, testExecutionId }) {
  const url = `${AGILETEST_BASE}/ds/test-executions/${Number(testExecutionId)}/test-cases`;

  const { data } = await withAgileTestRetry('execution test case list', () =>
    axios.get(url, {
      params: { projectId: String(projectId) },
      headers: authHeaders(jwtToken),
    }),
  );

  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.testCases)) return data.testCases;
  if (Array.isArray(data?.items)) return data.items;
  if (data == null) return [];

  throw new Error('Unexpected response from AgileTest /ds/test-executions/{id}/test-cases API');
}

// Link Jira Test Case issue id(s) to an AgileTest Test Execution.
export async function linkAgileTestTestCasesToExecution(
  jwtToken,
  { projectId, testExecutionId, testCaseIssueIds },
) {
  const url = `${AGILETEST_BASE}/ds/test-executions/${Number(testExecutionId)}/link/test-cases`;
  const payload = {
    projectId: String(projectId),
    testCaseIssueIds: testCaseIssueIds.map(String),
  };

  const { data } = await withAgileTestRetry('link test cases to execution', () =>
    axios.post(url, payload, { headers: authHeaders(jwtToken) }),
  );

  return data;
}

// ---------------------------------------------------------------------------
// Test plans
// ---------------------------------------------------------------------------

// Create AgileTest Test Plan(s) from Jira Test Plan issue id(s) with a date range.
export async function createAgileTestTestPlan(jwtToken, { projectId, testPlanIssueIds, startDate, endDate }) {
  const url = `${AGILETEST_BASE}/ds/test-plans`;
  const payload = {
    projectId: String(projectId),
    startDate,
    endDate,
    testPlanIssueIds: testPlanIssueIds.map(String),
  };

  const { data } = await withAgileTestRetry('create test plan', () =>
    axios.post(url, payload, { headers: authHeaders(jwtToken) }),
  );

  return data;
}

// Resolve AgileTest Test Plan(s) from Jira Test Plan issue id(s).
export async function getAgileTestTestPlansByJiraIssueIds(jwtToken, { projectId, testPlanIssueIds }) {
  const url = `${AGILETEST_BASE}/ds/test-plans/issue/bulk`;
  const payload = {
    projectId: String(projectId),
    testPlanIssueIds: testPlanIssueIds.map(String),
  };

  const { data } = await withAgileTestRetry('test plan lookup', () =>
    axios.post(url, payload, { headers: authHeaders(jwtToken) }),
  );

  return toEntityList(data, { label: '/ds/test-plans/issue/bulk', listKeys: ['testPlans', 'plans'] });
}

// Link Jira Test Case issue id(s) to an AgileTest Test Plan.
export async function linkAgileTestTestCasesToTestPlan(jwtToken, { projectId, testPlanId, testCaseIssueIds }) {
  const url = `${AGILETEST_BASE}/ds/test-plans/${Number(testPlanId)}/link/test-cases`;
  const payload = {
    projectId: String(projectId),
    testCaseIssueIds: testCaseIssueIds.map(String),
  };

  const { data } = await withAgileTestRetry('link test cases to test plan', () =>
    axios.post(url, payload, { headers: authHeaders(jwtToken) }),
  );

  return data;
}

// Assign AgileTest Test Execution(s) to an AgileTest Test Plan.
export async function linkAgileTestTestPlanToExecutions(
  jwtToken,
  { projectId, testPlanId, testExecutionIssueIds },
) {
  const url = `${AGILETEST_BASE}/ds/test-plans/${Number(testPlanId)}/link/test-executions`;
  const payload = {
    projectId: String(projectId),
    testExecutionIssueIds: testExecutionIssueIds.map(String),
  };

  const { data } = await withAgileTestRetry('link test plan to test executions', () =>
    axios.post(url, payload, { headers: authHeaders(jwtToken) }),
  );

  return data;
}

// ---------------------------------------------------------------------------
// Single test case lookups
// ---------------------------------------------------------------------------

// GET /ds/test-cases/{id} is deliberately NOT wrapped here. Verified against
// this instance (2026-10-18): without a testVersionId query param it returns
// 400 "Invalid value / testVersionId", and with one it returns
// 401 "Forge Invocation Token verification was unsuccessful", so there is no
// working AgileTest-id -> Jira-issue read path. Go the other way instead:
// getAgileTestTestcasesByJiraIssueIds (Jira issue id -> AgileTest test case).

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
