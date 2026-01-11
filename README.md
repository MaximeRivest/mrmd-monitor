# mrmd-monitor

A headless Yjs peer that monitors and executes code in mrmd notebooks, ensuring long-running executions survive browser disconnects.

## Why This Exists

### The Problem

In the original mrmd architecture:
- Browsers connect directly to MRP runtimes (mrmd-python, etc.)
- Browser writes execution output to Y.Text (the document)
- mrmd-sync handles Yjs synchronization and file persistence

This works great, but has one issue: **if a browser disconnects during a long-running execution, the connection to the runtime is lost and output stops flowing to the document.**

### Failed Approach: Hub Architecture

We tried making mrmd-sync a "hub" that:
- Routes all execution through the server
- Writes output directly to Y.Text from server-side
- Manages runtime connections centrally

This failed because:
1. **y-codemirror binding conflicts** - The binding expects changes to come from Yjs peers, not server-side manipulation
2. **Position finding is fragile** - Searching for `\`\`\`output:exec-123` markers breaks with concurrent edits
3. **Tight coupling** - Mixing sync logic with execution logic creates complexity
4. **Single point of failure** - If hub crashes, both sync AND execution die

### New Approach: Monitor as Yjs Peer

Instead of making the server special, we create a **headless Yjs client** that:
- Connects to mrmd-sync as a regular peer (just like browsers)
- Monitors execution requests
- Connects to MRP runtimes
- Writes output to Y.Text (through the normal Yjs sync flow)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────┐
│  Browser A  │     │  Browser B  │     │    mrmd-monitor     │
│  (editor)   │     │  (editor)   │     │  (headless peer)    │
└──────┬──────┘     └──────┬──────┘     └──────────┬──────────┘
       │                   │                       │
       │         Yjs sync (all equal peers)        │
       └─────────────────┬─────────────────────────┘
                         │
                         ▼
                ┌────────────────┐
                │   mrmd-sync    │
                │                │
                │  • Yjs provider│
                │  • File sync   │
                └────────────────┘
                         │
                         ▼
                    notebook.md
```

**Key insight:** The monitor writes to Y.Text exactly like a browser would. mrmd-sync doesn't know or care that it's special.

---

## Architecture

### Components

```
mrmd-monitor/
├── src/
│   ├── index.js           # Main entry, exports
│   ├── monitor.js         # RuntimeMonitor class
│   ├── execution.js       # Execution handling, MRP client
│   ├── document.js        # Y.Text manipulation (output blocks)
│   └── coordination.js    # Y.Map protocol for browser/monitor coordination
├── bin/
│   └── cli.js             # CLI entry point
├── package.json
└── README.md
```

### Data Flow

```
1. Browser wants to execute code
   │
   ▼
2. Browser writes to Y.Map('executions'):
   {
     "exec-123": {
       status: "requested",
       code: "print('hello')",
       language: "python",
       runtimeUrl: "http://localhost:8000/mrp/v1",
       requestedBy: <clientId>,
       requestedAt: <timestamp>
     }
   }
   │
   ▼
3. Monitor observes Y.Map change
   │
   ▼
4. Monitor claims execution:
   Y.Map.set("exec-123", { ...existing, status: "claimed", claimedBy: <monitorId> })
   │
   ▼
5. Browser sees claim, creates output block in Y.Text:
   ```python
   print('hello')
   ```

   ```output:exec-123
   ```
   │
   ▼
6. Browser confirms output block ready:
   Y.Map.set("exec-123", { ...existing, status: "ready", outputBlockReady: true })
   │
   ▼
7. Monitor connects to MRP runtime (SSE streaming)
   │
   ▼
8. Monitor writes output to Y.Text (finds output block, appends)
   Y.Map.set("exec-123", { ...existing, status: "running" })
   │
   ▼
9. Output syncs to all browsers via Yjs
   │
   ▼
10. Execution completes:
    Y.Map.set("exec-123", { ...existing, status: "completed", result: {...} })
```

---

## Coordination Protocol

### Y.Map('executions') Schema

```javascript
{
  "exec-<id>": {
    // Identity
    id: "exec-<id>",
    cellId: "cell-<id>",           // Optional: which cell this is for

    // Request (set by browser)
    code: "print('hello')",
    language: "python",
    runtimeUrl: "http://localhost:8000/mrp/v1",
    session: "default",            // MRP session ID

    // Coordination
    status: "requested" | "claimed" | "ready" | "running" | "completed" | "error" | "cancelled",
    requestedBy: <clientId>,       // Browser that requested
    requestedAt: <timestamp>,
    claimedBy: <clientId>,         // Monitor that claimed (or null)
    claimedAt: <timestamp>,

    // Output block coordination
    outputBlockReady: false,       // Browser sets true when output block exists
    outputPosition: {              // Yjs RelativePosition for output insertion
      type: <typeId>,
      item: <itemId>,
      assoc: 0
    },

    // Runtime state
    startedAt: <timestamp>,
    completedAt: <timestamp>,

    // Stdin coordination
    stdinRequest: null | {
      prompt: "Enter name: ",
      password: false,
      requestedAt: <timestamp>
    },
    stdinResponse: null | {
      text: "Alice\n",
      respondedAt: <timestamp>
    },

    // Result
    result: null | <any>,          // Final execution result
    error: null | {
      type: "NameError",
      message: "name 'foo' is not defined",
      traceback: [...]
    },

    // Rich outputs (stored here, rendered by browser)
    displayData: [
      {
        mimeType: "image/png",
        data: "base64...",         // Small outputs inline
        assetId: null              // Or reference to asset
      }
    ]
  }
}
```

### Status State Machine

```
                    ┌─────────────┐
                    │  requested  │ ← Browser creates
                    └──────┬──────┘
                           │
              Monitor claims│
                           ▼
                    ┌─────────────┐
                    │   claimed   │
                    └──────┬──────┘
                           │
       Browser creates     │
       output block        │
                           ▼
                    ┌─────────────┐
                    │    ready    │ ← Browser sets outputBlockReady=true
                    └──────┬──────┘
                           │
       Monitor starts      │
       MRP execution       │
                           ▼
                    ┌─────────────┐
                    │   running   │ ← Monitor streaming output
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
       ┌───────────┐ ┌───────────┐ ┌───────────┐
       │ completed │ │   error   │ │ cancelled │
       └───────────┘ └───────────┘ └───────────┘
```

### Browser Responsibilities

1. **Request execution:**
   - Generate unique execId
   - Write to Y.Map with status="requested"
   - Include code, language, runtimeUrl

2. **Create output block:**
   - Wait for status="claimed"
   - Insert `\`\`\`output:<execId>\n\`\`\`` in Y.Text after code cell
   - Store relative position in Y.Map
   - Set status="ready", outputBlockReady=true

3. **Handle stdin:**
   - Watch for stdinRequest in Y.Map
   - Show input UI to user
   - Write stdinResponse to Y.Map

4. **Render output:**
   - Output appears in Y.Text via Yjs sync (monitor writes it)
   - Rich outputs (images) in displayData, render via widgets

### Monitor Responsibilities

1. **Watch for requests:**
   - Observe Y.Map('executions')
   - Look for status="requested"

2. **Claim execution:**
   - Set status="claimed", claimedBy=<myClientId>
   - Only one monitor should claim (first wins via Yjs)

3. **Wait for output block:**
   - Watch for status="ready", outputBlockReady=true
   - Get outputPosition from Y.Map

4. **Execute:**
   - Connect to MRP runtime via SSE
   - Set status="running"
   - Stream output to Y.Text at outputPosition
   - Handle stdin requests (set stdinRequest, wait for stdinResponse)

5. **Complete:**
   - Set status="completed" or "error"
   - Store result/error in Y.Map
   - Store displayData for rich outputs

---

## Y.Text Output Writing

### Finding the Output Block

```javascript
function findOutputBlock(ytext, execId) {
  const text = ytext.toString();
  const marker = '```output:' + execId;
  const markerStart = text.indexOf(marker);

  if (markerStart === -1) return null;

  // Find the newline after marker
  const contentStart = text.indexOf('\n', markerStart) + 1;

  // Find the closing ```
  const closingBackticks = text.indexOf('\n```', contentStart);

  return {
    markerStart,
    contentStart,
    contentEnd: closingBackticks === -1 ? text.length : closingBackticks,
  };
}
```

### Appending Output

```javascript
function appendOutput(ytext, execId, content) {
  const block = findOutputBlock(ytext, execId);
  if (!block) {
    console.warn('Output block not found for', execId);
    return false;
  }

  // Insert just before the closing ```
  ytext.insert(block.contentEnd, content);
  return true;
}
```

### Using Relative Positions (Better)

Instead of searching by text, use Yjs RelativePosition:

```javascript
// Browser stores position when creating output block
const outputStart = /* position after ```output:exec-123\n */;
const relPos = Y.createRelativePositionFromTypeIndex(ytext, outputStart);

// Store in Y.Map
execMap.set(execId, {
  ...existing,
  outputPosition: Y.relativePositionToJSON(relPos)
});

// Monitor uses position
const relPos = Y.createRelativePositionFromJSON(exec.outputPosition);
const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
if (absPos) {
  ytext.insert(absPos.index, content);
}
```

---

## MRP Client

The monitor connects to MRP runtimes using the same protocol as browsers:

```javascript
async function executeStreaming(runtimeUrl, code, language, options = {}) {
  const response = await fetch(`${runtimeUrl}/execute/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      session: options.session || 'default',
      storeHistory: true,
    }),
  });

  // Parse SSE stream
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let currentEvent = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    for (const line of text.split('\n')) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7);
      } else if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));

        switch (currentEvent) {
          case 'stdout':
            options.onStdout?.(data.content, data.accumulated);
            break;
          case 'stderr':
            options.onStderr?.(data.content, data.accumulated);
            break;
          case 'stdin_request':
            options.onStdinRequest?.(data);
            break;
          case 'display':
            options.onDisplay?.(data);
            break;
          case 'result':
            options.onResult?.(data);
            break;
          case 'error':
            options.onError?.(data);
            break;
        }
      }
    }
  }
}
```

---

## CLI Usage

```bash
# Basic usage - connect to mrmd-sync and monitor executions
mrmd-monitor ws://localhost:4444

# With options
mrmd-monitor --doc notebook.md ws://localhost:4444

# Monitor specific document
mrmd-monitor --doc "projects/analysis.md" ws://localhost:4444
```

### Options

| Option | Description |
|--------|-------------|
| `--doc <path>` | Document to monitor (default: all documents) |
| `--log-level <level>` | Log level: debug, info, warn, error |
| `--name <name>` | Monitor name for Awareness |

---

## Implementation Plan

### Phase 1: Basic Execution

1. [ ] Connect to mrmd-sync as Yjs peer
2. [ ] Observe Y.Map('executions')
3. [ ] Claim executions with status="requested"
4. [ ] Wait for outputBlockReady
5. [ ] Connect to MRP runtime, stream output to Y.Text
6. [ ] Set completion status

### Phase 2: Stdin Support

1. [ ] Detect stdin_request from MRP
2. [ ] Set stdinRequest in Y.Map
3. [ ] Watch for stdinResponse
4. [ ] Send input to MRP runtime

### Phase 3: Rich Outputs

1. [ ] Handle displayData from MRP
2. [ ] Store small outputs inline in Y.Map
3. [ ] Large outputs: store as assets (future)

### Phase 4: Robustness

1. [ ] Handle monitor disconnect/reconnect
2. [ ] Handle runtime disconnect
3. [ ] Timeout for stuck executions
4. [ ] Multiple monitors (coordination)

---

## Comparison with Hub Approach

| Aspect | Hub (mrmd-sync) | Monitor (peer) |
|--------|-----------------|----------------|
| Complexity | High (all-in-one) | Low (separated) |
| Y.Text writes | Server-side (tricky) | Peer-side (natural) |
| Failure isolation | Poor | Good |
| Scaling | Hard | Easy (multiple monitors) |
| mrmd-sync changes | Major | None |
| y-codemirror compat | Issues | Works naturally |

---

## FAQ

### Why not just keep execution in the browser?

That works fine for short executions. But:
- Long-running ML training (hours)
- User closes laptop
- Browser crashes/refreshes

Output stops flowing. Monitor ensures it continues.

### Why a separate process instead of in mrmd-sync?

1. **Separation of concerns** - Sync is sync, execution is execution
2. **Failure isolation** - Monitor crash doesn't affect sync
3. **Scaling** - Can run multiple monitors
4. **Simplicity** - mrmd-sync stays simple

### What if monitor crashes during execution?

Execution keeps running on MRP runtime. When monitor restarts:
- It sees status="running" in Y.Map
- It can reconnect to MRP (if runtime supports resume)
- Or mark as error and let user re-run

### What about multiple monitors?

First one to set status="claimed" wins (Yjs handles concurrency).
Other monitors see it's claimed and skip.

### Can browser execute directly without monitor?

Yes! The original architecture still works. Monitor is additive.
Browser can execute directly for quick things.
Monitor is for "fire and forget" long-running executions.
