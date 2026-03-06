/**
 * E2E smoke test: compress-on-input wrapping real Playwright MCP
 *
 * Sends JSON-RPC messages to proxy → Playwright MCP, captures responses,
 * measures compression.
 */
const { spawn } = require('child_process');
const readline = require('readline');

const PLAYWRIGHT_CMD = '/Users/vova/.claude/scripts/playwright-project.sh';
const PLAYWRIGHT_ARGS = ['personal'];

// Start proxy wrapping Playwright
const proxy = spawn('node', [
  'dist/index.js',
  '--wrap', `${PLAYWRIGHT_CMD} ${PLAYWRIGHT_ARGS.join(' ')}`,
  '--verbose'
], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname + '/..',
});

let stderr = '';
proxy.stderr.on('data', (d) => {
  const s = d.toString();
  stderr += s;
  process.stderr.write(s);
});

const rl = readline.createInterface({ input: proxy.stdout });
const pending = new Map();
let nextId = 1;

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line.trim());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  } catch {}
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const msg = { jsonrpc: '2.0', id, method, params };
    proxy.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout for ${method} (id=${id})`));
      }
    }, 30000);
  });
}

function tokenEstimate(content) {
  if (!content || !Array.isArray(content)) return 0;
  return content.reduce((sum, block) => {
    if (block.type === 'image' && block.data) return sum + Math.ceil(block.data.length / 4);
    if (block.text) return sum + Math.ceil(Buffer.byteLength(block.text, 'utf-8') / 4);
    return sum;
  }, 0);
}

async function run() {
  console.log('=== compress-on-input Smoke Test with Playwright MCP ===\n');

  // 1. Initialize
  console.log('1. Initializing MCP connection...');
  const initResult = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0' }
  });
  console.log('   Protocol version:', initResult.result?.protocolVersion || 'unknown');

  // Send initialized notification
  proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await new Promise(r => setTimeout(r, 500));

  // 2. List tools
  console.log('\n2. Listing available tools...');
  const toolsResult = await send('tools/list');
  const tools = toolsResult.result?.tools || [];
  console.log(`   Found ${tools.length} tools:`, tools.map(t => t.name).join(', '));

  // 3. Navigate to a page with more content
  console.log('\n3. Navigating to github.com (more complex DOM)...');
  const navResult = await send('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'https://github.com/Chill-AI-Space/compress-on-input' }
  });
  const navTokens = tokenEstimate(navResult.result?.content);
  console.log(`   Navigate result: ${navTokens} tokens`);

  // 4. Take screenshot (this is the big test!)
  console.log('\n4. Taking screenshot (OCR compression test)...');
  const screenshotResult = await send('tools/call', {
    name: 'browser_take_screenshot',
    arguments: {}
  });
  const ssContent = screenshotResult.result?.content || [];
  const ssTokens = tokenEstimate(ssContent);
  const ssType = ssContent[0]?.type;
  console.log(`   Result type: ${ssType}`);
  console.log(`   Result tokens: ${ssTokens}`);
  if (ssType === 'text') {
    console.log(`   OCR text preview: ${ssContent[0].text.slice(0, 200)}...`);
    console.log('   >>> SCREENSHOT COMPRESSED TO TEXT VIA OCR <<<');
  } else {
    console.log('   WARNING: Screenshot was NOT compressed (returned as image)');
  }

  // 5. Take DOM snapshot (dom-cleanup test)
  console.log('\n5. Taking DOM snapshot (dom-cleanup test)...');
  const snapshotResult = await send('tools/call', {
    name: 'browser_snapshot',
    arguments: {}
  });
  const snapContent = snapshotResult.result?.content || [];
  const snapTokens = tokenEstimate(snapContent);
  const snapText = snapContent[0]?.text || '';
  const hasRefInline = /\[ref=[\w]+\]/.test(snapText);
  const hasMappingTable = snapText.includes('[Element references]');
  console.log(`   Snapshot tokens: ${snapTokens}`);
  console.log(`   Has inline [ref=N]: ${hasRefInline}`);
  console.log(`   Has mapping table: ${hasMappingTable}`);
  if (!hasRefInline && hasMappingTable) {
    console.log('   >>> DOM CLEANUP WORKING: refs moved to mapping table <<<');
  }
  console.log(`   Text preview: ${snapText.slice(0, 300)}...`);

  // 6. Close browser
  console.log('\n6. Closing browser...');
  await send('tools/call', { name: 'browser_close', arguments: {} });

  // Summary
  console.log('\n=== SMOKE TEST RESULTS ===');
  console.log(`Screenshot: type=${ssType}, tokens=${ssTokens}`);
  console.log(`DOM snapshot: tokens=${snapTokens}, inline_refs=${hasRefInline}, mapping_table=${hasMappingTable}`);
  console.log('\nStderr logs (compression stats):');
  const statsLines = stderr.split('\n').filter(l => l.includes('tokens') && l.includes('reduction'));
  statsLines.forEach(l => console.log('  ' + l));

  proxy.kill();
  process.exit(0);
}

run().catch((err) => {
  console.error('Test failed:', err);
  proxy.kill();
  process.exit(1);
});
