/**
 * Runtime Monitor
 *
 * Main monitor class that connects to mrmd-sync as a Yjs peer
 * and handles execution requests.
 *
 * @module mrmd-monitor/monitor
 */

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { CoordinationProtocol, EXECUTION_STATUS } from './coordination.js';
import { DocumentWriter } from './document.js';
import { ExecutionHandler } from './execution.js';

/**
 * @typedef {Object} MonitorOptions
 * @property {string} [name='mrmd-monitor'] - Monitor name for Awareness
 * @property {string} [color='#10b981'] - Monitor color for Awareness
 * @property {Function} [log] - Logger function
 */

/**
 * Runtime Monitor
 *
 * Connects to mrmd-sync as a Yjs peer and handles execution requests.
 */
export class RuntimeMonitor {
  /**
   * @param {string} syncUrl - WebSocket URL for mrmd-sync
   * @param {string} docPath - Document path/room name
   * @param {MonitorOptions} [options]
   */
  constructor(syncUrl, docPath, options = {}) {
    /** @type {string} */
    this.syncUrl = syncUrl;

    /** @type {string} */
    this.docPath = docPath;

    /** @type {MonitorOptions} */
    this.options = {
      name: 'mrmd-monitor',
      color: '#10b981',
      log: console.log,
      ...options,
    };

    /** @type {Y.Doc} */
    this.ydoc = new Y.Doc();

    /** @type {WebsocketProvider|null} */
    this.provider = null;

    /** @type {CoordinationProtocol|null} */
    this.coordination = null;

    /** @type {DocumentWriter|null} */
    this.writer = null;

    /** @type {ExecutionHandler} */
    this.executor = new ExecutionHandler();

    /** @type {boolean} */
    this._connected = false;

    /** @type {boolean} */
    this._synced = false;

    /** @type {Function|null} */
    this._unsubscribe = null;

    /** @type {Set<string>} */
    this._processingExecutions = new Set();
  }

  /**
   * Log helper
   * @param {string} level
   * @param {string} message
   * @param {Object} [data]
   */
  _log(level, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      component: 'monitor',
      message,
      ...data,
    };
    this.options.log(JSON.stringify(entry));
  }

  /**
   * Connect to mrmd-sync
   *
   * @returns {Promise<void>} Resolves when connected and synced
   */
  connect() {
    return new Promise((resolve, reject) => {
      this._log('info', 'Connecting to sync server', { url: this.syncUrl, doc: this.docPath });

      this.provider = new WebsocketProvider(this.syncUrl, this.docPath, this.ydoc, {
        connect: true,
      });

      // Set up awareness
      this.provider.awareness.setLocalStateField('user', {
        name: this.options.name,
        color: this.options.color,
        type: 'monitor',
      });

      // Track connection status
      this.provider.on('status', ({ status }) => {
        const wasConnected = this._connected;
        this._connected = status === 'connected';

        if (this._connected && !wasConnected) {
          this._log('info', 'Connected to sync server');
        } else if (!this._connected && wasConnected) {
          this._log('warn', 'Disconnected from sync server');
        }
      });

      // Wait for sync
      this.provider.on('synced', ({ synced }) => {
        if (synced && !this._synced) {
          this._synced = true;
          this._log('info', 'Document synced');

          // Initialize coordination and writer
          this.coordination = new CoordinationProtocol(this.ydoc, this.ydoc.clientID);
          this.writer = new DocumentWriter(this.ydoc);

          // Start watching for execution requests
          this._startWatching();

          resolve();
        }
      });

      // Handle connection errors
      this.provider.on('connection-error', (err) => {
        this._log('error', 'Connection error', { error: err.message });
        reject(err);
      });
    });
  }

  /**
   * Start watching for execution requests
   */
  _startWatching() {
    this._log('info', 'Starting execution watcher');

    this._unsubscribe = this.coordination.observe((execId, exec, action) => {
      if (!exec) return;

      // Handle new requests
      if (exec.status === EXECUTION_STATUS.REQUESTED) {
        this._handleRequest(execId, exec);
      }

      // Handle ready (output block created)
      if (exec.status === EXECUTION_STATUS.READY && exec.claimedBy === this.ydoc.clientID) {
        this._handleReady(execId, exec);
      }

      // Handle stdin responses
      if (exec.stdinResponse && exec.claimedBy === this.ydoc.clientID) {
        this._handleStdinResponse(execId, exec);
      }
    });

    // Also check for any existing requests we might have missed
    this._checkExistingRequests();
  }

  /**
   * Check for existing requests on startup
   */
  _checkExistingRequests() {
    const requested = this.coordination.getExecutionsByStatus(EXECUTION_STATUS.REQUESTED);
    for (const exec of requested) {
      this._handleRequest(exec.id, exec);
    }

    // Also check for any we claimed but didn't start (e.g., after restart)
    const ready = this.coordination.getExecutionsByStatus(EXECUTION_STATUS.READY);
    for (const exec of ready) {
      if (exec.claimedBy === this.ydoc.clientID) {
        this._handleReady(exec.id, exec);
      }
    }
  }

  /**
   * Handle execution request
   *
   * @param {string} execId
   * @param {Object} exec
   */
  _handleRequest(execId, exec) {
    // Don't claim if already processing
    if (this._processingExecutions.has(execId)) return;

    this._log('info', 'New execution request', { execId, language: exec.language });

    // Try to claim it
    const claimed = this.coordination.claimExecution(execId);
    if (claimed) {
      this._log('info', 'Claimed execution', { execId });
      this._processingExecutions.add(execId);
    } else {
      this._log('debug', 'Could not claim execution (already claimed)', { execId });
    }
  }

  /**
   * Handle execution ready (output block created)
   *
   * @param {string} execId
   * @param {Object} exec
   */
  async _handleReady(execId, exec) {
    // Don't start twice
    if (this.executor.isActive(execId)) return;

    this._log('info', 'Starting execution', { execId, language: exec.language });

    // Mark as running
    this.coordination.setRunning(execId);

    try {
      // Track accumulated output for writing to Y.Text
      let lastWrittenLength = 0;

      await this.executor.execute(exec.runtimeUrl, exec.code, {
        session: exec.session,
        execId,
        callbacks: {
          onStdout: (chunk, accumulated) => {
            // Write new content to Y.Text
            const newContent = accumulated.slice(lastWrittenLength);
            if (newContent) {
              this.writer.appendOutput(execId, newContent);
              lastWrittenLength = accumulated.length;
            }
          },

          onStderr: (chunk, accumulated) => {
            // Write stderr to Y.Text (could prefix with marker)
            const newContent = accumulated.slice(lastWrittenLength);
            if (newContent) {
              this.writer.appendOutput(execId, newContent);
              lastWrittenLength = accumulated.length;
            }
          },

          onStdinRequest: (request) => {
            this._log('info', 'Stdin request', { execId, prompt: request.prompt });
            this.coordination.requestStdin(execId, {
              prompt: request.prompt,
              password: request.password,
            });
          },

          onDisplay: (display) => {
            this._log('debug', 'Display data', { execId, mimeType: display.mimeType });
            this.coordination.addDisplayData(execId, display);
          },

          onResult: (result) => {
            this._log('info', 'Execution completed', { execId, success: result.success });
            this.coordination.setCompleted(execId, {
              result: result.result,
              displayData: result.displayData,
            });
          },

          onError: (error) => {
            this._log('error', 'Execution error', { execId, error: error.message });
            this.coordination.setError(execId, error);
          },
        },
      });

    } catch (err) {
      this._log('error', 'Execution failed', { execId, error: err.message });
      this.coordination.setError(execId, {
        type: 'MonitorError',
        message: err.message,
      });

    } finally {
      this._processingExecutions.delete(execId);
    }
  }

  /**
   * Handle stdin response from browser
   *
   * @param {string} execId
   * @param {Object} exec
   */
  async _handleStdinResponse(execId, exec) {
    if (!exec.stdinResponse) return;

    this._log('debug', 'Stdin response received', { execId });

    try {
      await this.executor.sendInput(
        exec.runtimeUrl,
        exec.session,
        execId,
        exec.stdinResponse.text
      );

      // Clear the request
      this.coordination.clearStdinRequest(execId);

    } catch (err) {
      this._log('error', 'Failed to send stdin', { execId, error: err.message });
    }
  }

  /**
   * Disconnect from sync server
   */
  disconnect() {
    this._log('info', 'Disconnecting');

    // Cancel active executions
    this.executor.cancelAll();

    // Stop watching
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    // Clean up coordination
    if (this.coordination) {
      this.coordination.destroy();
      this.coordination = null;
    }

    // Disconnect provider
    if (this.provider) {
      this.provider.disconnect();
      this.provider = null;
    }

    this._connected = false;
    this._synced = false;
  }

  /**
   * Check if connected
   *
   * @returns {boolean}
   */
  get isConnected() {
    return this._connected && this._synced;
  }

  /**
   * Get active execution count
   *
   * @returns {number}
   */
  get activeExecutions() {
    return this.executor.activeCount;
  }
}

/**
 * Create and connect a monitor
 *
 * @param {string} syncUrl - WebSocket URL for mrmd-sync
 * @param {string} docPath - Document path/room name
 * @param {MonitorOptions} [options]
 * @returns {Promise<RuntimeMonitor>}
 */
export async function createMonitor(syncUrl, docPath, options = {}) {
  const monitor = new RuntimeMonitor(syncUrl, docPath, options);
  await monitor.connect();
  return monitor;
}
