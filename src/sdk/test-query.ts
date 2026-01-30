/**
 * Test script for SDK query
 * Run with: npx tsx src/sdk/test-query.ts
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

async function main() {
  console.log('Starting SDK test query...');

  const q = query({
    prompt: 'What is 2+2? Answer with just the number.',
    options: {
      allowedTools: [], // No tools for this simple test
    },
  });

  console.log('Query created, processing messages...\n');

  for await (const message of q) {
    console.log(`[${message.type}]`, message.type === 'assistant' ? '(streaming...)' : '');

    // Show init message
    if (message.type === 'system' && message.subtype === 'init') {
      console.log('  Model:', message.model);
      console.log('  Session ID:', message.session_id);
    }

    // Show assistant text
    if (message.type === 'assistant') {
      const content = message.message.content;
      for (const block of content) {
        if (block.type === 'text') {
          console.log('  Claude:', block.text);
        }
      }
    }

    // Show result
    if (message.type === 'result') {
      console.log('\n--- Result ---');
      console.log('  Success:', message.subtype === 'success');
      if (message.subtype === 'success') {
        console.log('  Result:', message.result);
        console.log('  Duration:', message.duration_ms, 'ms');
        console.log('  Cost: $', message.total_cost_usd.toFixed(4));
      }
    }
  }

  console.log('\nTest complete!');
}

main().catch(console.error);
