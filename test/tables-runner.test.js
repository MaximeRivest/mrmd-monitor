import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDefaultExec } from '../src/tables/runner.js';

test('createDefaultExec executes a subprocess contract and reads csv cache rows', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mrmd-monitor-runner-'));

  try {
    const exec = createDefaultExec({
      projectRoot: tempDir,
      documentPath: 'notes/demo.md',
    });

    await fs.mkdir(path.join(tempDir, 'notes'), { recursive: true });

    const result = await exec({
      executable: process.execPath,
      args: [],
      cwd: path.join(tempDir, 'notes'),
      env: {},
      scriptText: [
        "const fs = require('node:fs');",
        "fs.mkdirSync(require('node:path').dirname(process.env.MRMD_CACHE_PATH), { recursive: true });",
        "fs.writeFileSync(process.env.MRMD_CACHE_PATH, 'Region,Revenue\\nNorth,12.50\\nSouth,8.25\\n');",
      ].join('\n'),
      transformPath: '../_assets/tables/sales-summary/transform.js',
      cachePath: '../_assets/tables/sales-summary/cache.csv',
      cacheFormat: 'csv',
    });

    assert.equal(result.rowCount, 2);
    assert.deepEqual(result.columnNames, ['Region', 'Revenue']);
    assert.deepEqual(result.rows, [
      { Region: 'North', Revenue: '12.50' },
      { Region: 'South', Revenue: '8.25' },
    ]);
    assert.ok(result.artifacts.cacheExists);
    assert.ok(result.artifacts.scriptPath.endsWith(path.join('_assets', 'tables', 'sales-summary', 'transform.js')));
    assert.ok(result.resolvedCachePath.endsWith(path.join('_assets', 'tables', 'sales-summary', 'cache.csv')));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
