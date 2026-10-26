#!/usr/bin/env node
const stages = {
  assessing: 'ASSESSING',
  planned: 'PLANNED',
  working: 'WORKING',
  review: 'REVIEW',
  needs_input: 'NEEDS_INPUT',
};

const stage = stages[process.argv[2]?.toLowerCase() ?? ''];
const message = process.argv.slice(3).join(' ').trim();
const apiUrl = process.env.AGENT_API_URL?.trim().replace(/\/+$/, '');
const runId = process.env.AGENT_RUN_ID?.trim();
const leaseToken = process.env.AGENT_LEASE_TOKEN?.trim();

if (!stage || !message) {
  console.error('Usage: node scripts/agent-report.mjs <assessing|planned|working|review|needs_input> "message"');
  process.exit(2);
}
if (!apiUrl || !runId || !leaseToken) {
  console.error('agent-report: AGENT_API_URL, AGENT_RUN_ID and AGENT_LEASE_TOKEN are required');
  process.exit(2);
}

try {
  const safeMessage = message.split(leaseToken).join('[redacted]');
  const response = await fetch(new URL(`/api/agent/runs/${encodeURIComponent(runId)}/events`, apiUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ leaseToken, stage, message: safeMessage.slice(0, 4000) }),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`agent-report: ${response.status} ${payload.error ?? 'REQUEST_FAILED'}`);
    process.exit(1);
  }
  console.log(`agent-report: ${stage}`);
} catch (error) {
  console.error(`agent-report: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
