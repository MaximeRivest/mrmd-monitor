import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';

import { findLinkedTableBlocks } from '../../mrmd-table-spec/src/index.js';
import { createLinkedTableBlockAnchor } from '../src/tables/snapshot-rewriter.js';
import { TableJobsBridge, TABLE_JOB_STATUS } from '../src/tables/index.js';

function requestSortJob(ydoc, options) {
  const jobs = ydoc.getMap('tableJobs');
  const jobId = `tablejob-test-${Math.random().toString(36).slice(2, 8)}`;
  jobs.set(jobId, {
    id: jobId,
    tableId: options.tableId,
    jobType: 'applyOps',
    status: TABLE_JOB_STATUS.REQUESTED,
    requestedBy: 777,
    requestedAt: Date.now(),
    claimedBy: null,
    claimedAt: null,
    completedAt: null,
    blockAnchor: options.blockAnchor,
    spec: options.spec,
    opList: [{ type: 'sort', column: options.column, direction: options.direction || 'asc' }],
    metadata: {},
    result: null,
    error: null,
  });
  return jobId;
}

function waitForTableJobStatus(ydoc, jobId, targetStatus, timeout = 3000) {
  const jobs = ydoc.getMap('tableJobs');
  const targets = Array.isArray(targetStatus) ? targetStatus : [targetStatus];

  return new Promise((resolve, reject) => {
    const current = jobs.get(jobId);
    if (current && targets.includes(current.status)) {
      resolve(current);
      return;
    }

    const observer = (event) => {
      if (!event.changes.keys.has(jobId)) return;
      const job = jobs.get(jobId);
      if (!job || !targets.includes(job.status)) return;
      jobs.unobserve(observer);
      clearTimeout(timeoutId);
      resolve(job);
    };

    const timeoutId = setTimeout(() => {
      jobs.unobserve(observer);
      reject(new Error(`Timeout waiting for table job status ${targets.join('/')} on ${jobId}`));
    }, timeout);

    jobs.observe(observer);
  });
}

test('TableJobsBridge claims, runs, and rewrites a linked-table sort job end to end', async () => {
  const markdown = `# Demo

<!--mrmd:table
version: 1
id: sales-summary
label: Sales summary
engine: r-dplyr
sources:
  - name: sales
    role: primary
    kind: file
    path: ../_assets/tables/sales-summary/source.csv
    format: csv
transform:
  path: ../_assets/tables/sales-summary/transform.R
cache:
  path: ../_assets/tables/sales-summary/cache.arrow
-->
| Region | Revenue |
| --- | ---: |
| South | 8.25 |
| North | 12.50 |
`;

  const initialRows = [
    { Region: 'South', Revenue: '8.25' },
    { Region: 'North', Revenue: '12.50' },
  ];

  const ydoc = new Y.Doc();
  const yText = ydoc.getText('content');
  yText.insert(0, markdown);

  const block = findLinkedTableBlocks(markdown)[0];
  const blockAnchor = createLinkedTableBlockAnchor(yText, {
    from: block.headerFrom,
    to: block.snapshotTo,
    tableId: block.spec.id,
  });

  const bridge = new TableJobsBridge({
    ydoc,
    exec: async (contract) => {
      const descending = /arrange\(desc\(Revenue\)\)/.test(contract.scriptText);
      const rows = initialRows.slice().sort((left, right) => {
        const a = Number.parseFloat(left.Revenue);
        const b = Number.parseFloat(right.Revenue);
        return descending ? b - a : a - b;
      });

      return {
        rows,
        columnNames: ['Region', 'Revenue'],
        rowCount: rows.length,
      };
    },
  });

  const jobId = requestSortJob(ydoc, {
    tableId: block.spec.id,
    blockAnchor,
    spec: block.spec,
    column: 'Revenue',
    direction: 'desc',
  });

  const completed = await waitForTableJobStatus(ydoc, jobId, TABLE_JOB_STATUS.COMPLETED, 3000);

  assert.equal(completed.status, TABLE_JOB_STATUS.COMPLETED);
  assert.equal(completed.result.snapshot.rowCount, 2);
  assert.equal(completed.result.updatedSpec.snapshot.rowCount, 2);
  assert.ok(completed.result.updatedSpec.snapshot.materializedAt);
  assert.equal(completed.result.blockAnchor.tableId, 'sales-summary');

  const rewritten = yText.toString();
  assert.ok(rewritten.includes('snapshot:'));
  assert.ok(rewritten.includes('rowCount: 2'));
  assert.ok(rewritten.includes('materializedAt:'));
  assert.ok(rewritten.indexOf('| North | 12.50 |') < rewritten.indexOf('| South | 8.25 |'));

  bridge.destroy();
});

test('TableJobsBridge marks job errors when runtime execution fails', async () => {
  const markdown = `<!--mrmd:table
id: broken-table
engine: r-dplyr
sources:
  - name: sales
    path: ../_assets/tables/broken-table/source.csv
transform:
  path: ../_assets/tables/broken-table/transform.R
cache:
  path: ../_assets/tables/broken-table/cache.arrow
-->
| Revenue |
| ---: |
| 1 |
`;

  const ydoc = new Y.Doc();
  const yText = ydoc.getText('content');
  yText.insert(0, markdown);

  const block = findLinkedTableBlocks(markdown)[0];
  const bridge = new TableJobsBridge({
    ydoc,
    exec: async () => {
      throw new Error('Synthetic execution failure');
    },
  });

  const jobId = requestSortJob(ydoc, {
    tableId: block.spec.id,
    blockAnchor: createLinkedTableBlockAnchor(yText, {
      from: block.headerFrom,
      to: block.snapshotTo,
      tableId: block.spec.id,
    }),
    spec: block.spec,
    column: 'Revenue',
    direction: 'desc',
  });

  const errored = await waitForTableJobStatus(ydoc, jobId, TABLE_JOB_STATUS.ERROR, 3000);
  assert.equal(errored.status, TABLE_JOB_STATUS.ERROR);
  assert.match(errored.error.message, /Synthetic execution failure/);

  bridge.destroy();
});
