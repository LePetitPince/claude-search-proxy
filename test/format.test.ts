/**
 * Tests for response formatting utilities (pure functions)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractCitations, formatOpenAIResponse, extractQuery, formatErrorResponse } from '../src/format.js';
import type { ClaudeResult } from '../src/types.js';

describe('extractCitations', () => {
  it('should extract markdown links', () => {
    const text = 'Tokyo has a population of 14 million. [Tokyo Population](https://example.com/tokyo) shows recent data.';
    const result = extractCitations(text);

    assert.deepStrictEqual(result.citations, ['https://example.com/tokyo']);
    assert.ok(!result.cleanedText.includes('https://'));
  });

  it('should extract bare URLs', () => {
    const text = 'Visit https://example.com for more info. Also check http://test.org/path';
    const result = extractCitations(text);

    assert.deepStrictEqual(result.citations, ['https://example.com', 'http://test.org/path']);
  });

  it('should deduplicate URLs', () => {
    const text = '[Link1](https://example.com) and [Link2](https://example.com) and https://example.com';
    const result = extractCitations(text);

    assert.deepStrictEqual(result.citations, ['https://example.com']);
  });

  it('should remove Sources section at end', () => {
    const text = `Tokyo population is 14 million.

Sources:
- [Wikipedia](https://en.wikipedia.org/wiki/Tokyo)
- [City Data](https://citydata.com/tokyo)`;

    const result = extractCitations(text);

    assert.deepStrictEqual(result.citations, [
      'https://en.wikipedia.org/wiki/Tokyo',
      'https://citydata.com/tokyo'
    ]);
    assert.strictEqual(result.cleanedText, 'Tokyo population is 14 million.');
  });

  it('should handle empty text', () => {
    const result = extractCitations('');
    assert.deepStrictEqual(result.citations, []);
    assert.strictEqual(result.cleanedText, '');
  });

  it('should ignore invalid URLs', () => {
    const text = '[Bad Link](not-a-url) and [Good Link](https://example.com)';
    const result = extractCitations(text);

    assert.deepStrictEqual(result.citations, ['https://example.com']);
  });

  it('should handle real Claude WebSearch output format', () => {
    const text = `Tokyo's population depends on which boundary definition is used:

- **City proper (Tokyo Metropolis):** ~14.2 million
- **Greater Tokyo metro area:** ~37 million

Sources:
- [Tokyo Population 2026 - World Population Review](https://worldpopulationreview.com/cities/japan/tokyo)
- [Tokyo Metro Area Population - MacroTrends](https://www.macrotrends.net/global-metrics/cities/21671/tokyo/population)`;

    const result = extractCitations(text);

    assert.strictEqual(result.citations.length, 2);
    assert.ok(result.citations[0].includes('worldpopulationreview.com'));
    assert.ok(result.citations[1].includes('macrotrends.net'));
    assert.ok(result.cleanedText.includes('14.2 million'));
    assert.ok(!result.cleanedText.includes('Sources:'));
  });

  it('should handle URLs with query params and fragments', () => {
    const text = 'See [article](https://example.com/page?q=test&lang=en#section) for details.';
    const result = extractCitations(text);

    assert.deepStrictEqual(result.citations, ['https://example.com/page?q=test&lang=en#section']);
  });
});

describe('formatOpenAIResponse', () => {
  it('should format Claude result to OpenAI response shape', () => {
    const claudeResult: ClaudeResult = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 5000,
      result: 'Tokyo has 14 million people.\n\nSources:\n- [Source](https://example.com/tokyo)',
      session_id: 'test-session-123',
      total_cost_usd: 0.16,
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300
      }
    };

    const response = formatOpenAIResponse(claudeResult, 'claude-sonnet-4');

    assert.strictEqual(response.object, 'chat.completion');
    assert.strictEqual(response.model, 'claude-sonnet-4');
    assert.strictEqual(response.choices.length, 1);
    assert.strictEqual(response.choices[0].message.role, 'assistant');
    assert.strictEqual(response.choices[0].finish_reason, 'stop');
    assert.deepStrictEqual(response.citations, ['https://example.com/tokyo']);
    assert.strictEqual(response.usage.prompt_tokens, 100);
    assert.strictEqual(response.usage.completion_tokens, 200);
    assert.ok(response.id.startsWith('search-'));
    assert.ok(typeof response.created === 'number');
  });

  it('should handle missing usage data gracefully', () => {
    const claudeResult: ClaudeResult = {
      type: 'result',
      is_error: false,
      duration_ms: 5000,
      result: 'Test result',
      session_id: 'test-session',
      total_cost_usd: 0.0
    };

    const response = formatOpenAIResponse(claudeResult, 'test-model');

    assert.strictEqual(response.usage.prompt_tokens, 0);
    assert.strictEqual(response.usage.completion_tokens, 0);
    assert.strictEqual(response.usage.total_tokens, 0);
  });

  it('should produce valid JSON', () => {
    const claudeResult: ClaudeResult = {
      type: 'result',
      is_error: false,
      duration_ms: 1000,
      result: 'Result with "quotes" and special chars: <>&',
      session_id: 'test',
      total_cost_usd: 0.0
    };

    const response = formatOpenAIResponse(claudeResult, 'model');
    const json = JSON.stringify(response);
    const reparsed = JSON.parse(json);

    assert.deepStrictEqual(reparsed.choices[0].message.content, response.choices[0].message.content);
  });
});

describe('extractQuery', () => {
  it('should extract last user message', () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'What is the weather?' }
    ];

    assert.strictEqual(extractQuery(messages), 'What is the weather?');
  });

  it('should trim whitespace', () => {
    const messages = [{ role: 'user', content: '  search query  \n' }];
    assert.strictEqual(extractQuery(messages), 'search query');
  });

  it('should throw if no user message', () => {
    assert.throws(
      () => extractQuery([{ role: 'system', content: 'System' }]),
      /No user message found/
    );
  });

  it('should throw for empty messages', () => {
    assert.throws(() => extractQuery([]), /No user message found/);
  });
});

describe('formatErrorResponse', () => {
  it('should format error with custom type', () => {
    const response = formatErrorResponse('Test error', 'test_error');
    assert.deepStrictEqual(response, {
      error: { message: 'Test error', type: 'test_error' }
    });
  });

  it('should default to internal_error type', () => {
    const response = formatErrorResponse('Test error');
    assert.strictEqual(response.error.type, 'internal_error');
  });
});
