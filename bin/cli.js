#!/usr/bin/env node

/**
 * mrmd-monitor CLI
 *
 * Headless Yjs peer for monitoring and executing code in mrmd notebooks.
 *
 * Usage:
 *   mrmd-monitor ws://localhost:4444
 *   mrmd-monitor --doc notebook.md ws://localhost:4444
 */

import { RuntimeMonitor } from '../src/monitor.js';

// Parse arguments
const args = process.argv.slice(2);

const options = {
  doc: null,
  logLevel: 'info',
  name: 'mrmd-monitor',
};

let syncUrl = null;

function printHelp() {
  console.log(`
mrmd-monitor - Headless Yjs peer for execution monitoring

Usage:
  mrmd-monitor [options] <sync-url>

Arguments:
  sync-url              WebSocket URL for mrmd-sync (e.g., ws://localhost:4444)

Options:
  --doc <path>          Document to monitor (default: first document)
  --name <name>         Monitor name for Awareness (default: mrmd-monitor)
  --log-level <level>   Log level: debug, info, warn, error (default: info)
  --help, -h            Show this help

Examples:
  mrmd-monitor ws://localhost:4444
  mrmd-monitor --doc notebook.md ws://localhost:4444
  mrmd-monitor --log-level debug ws://localhost:4444

The monitor connects to mrmd-sync as a Yjs peer and:
  - Watches for execution requests in Y.Map('executions')
  - Claims and executes requests via MRP runtimes
  - Writes output to Y.Text (the document)
  - Handles stdin requests from runtimes
`);
}

// Parse arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === '--help' || arg === '-h') {
    printHelp();
    process.exit(0);
  } else if (arg === '--doc') {
    options.doc = args[++i];
    if (!options.doc) {
      console.error('Error: --doc requires a path');
      process.exit(1);
    }
  } else if (arg === '--name') {
    options.name = args[++i];
    if (!options.name) {
      console.error('Error: --name requires a value');
      process.exit(1);
    }
  } else if (arg === '--log-level') {
    options.logLevel = args[++i];
    if (!['debug', 'info', 'warn', 'error'].includes(options.logLevel)) {
      console.error('Error: --log-level must be debug, info, warn, or error');
      process.exit(1);
    }
  } else if (!arg.startsWith('-')) {
    syncUrl = arg;
  } else {
    console.error(`Unknown option: ${arg}`);
    console.error('Run with --help for usage');
    process.exit(1);
  }
}

// Validate
if (!syncUrl) {
  console.error('Error: sync-url is required');
  console.error('Run with --help for usage');
  process.exit(1);
}

// Ensure URL has protocol
if (!syncUrl.startsWith('ws://') && !syncUrl.startsWith('wss://')) {
  syncUrl = 'ws://' + syncUrl;
}

// Document path - if not specified, use a default
const docPath = options.doc || 'default';

// Logging
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LOG_LEVELS[options.logLevel] ?? 1;

function log(entry) {
  try {
    const parsed = JSON.parse(entry);
    if (LOG_LEVELS[parsed.level] >= minLevel) {
      const time = parsed.timestamp.split('T')[1].split('.')[0];
      const level = parsed.level.toUpperCase().padEnd(5);
      const msg = parsed.message;
      const extra = Object.keys(parsed)
        .filter(k => !['timestamp', 'level', 'component', 'message'].includes(k))
        .map(k => `${k}=${JSON.stringify(parsed[k])}`)
        .join(' ');

      console.log(`[${time}] ${level} ${msg}${extra ? ' ' + extra : ''}`);
    }
  } catch {
    console.log(entry);
  }
}

// Start monitor
console.log('');
console.log('\x1b[36m%s\x1b[0m', '  mrmd-monitor');
console.log('  ────────────');
console.log(`  Sync:     ${syncUrl}`);
console.log(`  Document: ${docPath}`);
console.log(`  Name:     ${options.name}`);
console.log('');

const monitor = new RuntimeMonitor(syncUrl, docPath, {
  name: options.name,
  log,
});

// Handle shutdown
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('');
  log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    message: `Received ${signal}, shutting down...`,
  }));

  monitor.disconnect();

  // Give time for cleanup
  setTimeout(() => {
    process.exit(0);
  }, 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Connect
monitor.connect()
  .then(() => {
    log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'Monitor ready, waiting for execution requests...',
    }));
  })
  .catch((err) => {
    console.error('Failed to connect:', err.message);
    process.exit(1);
  });
