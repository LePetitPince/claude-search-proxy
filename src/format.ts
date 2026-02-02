/**
 * Response formatting utilities for converting Claude output to OpenAI format
 */

import { randomUUID } from 'crypto';
import type { ClaudeResult, OpenAIResponse, ExtractedCitations } from './types.js';

/**
 * Extract URLs from Claude result text using regex patterns
 * Supports both markdown links [text](url) and bare URLs
 */
export function extractCitations(text: string): ExtractedCitations {
  const citations: string[] = [];
  const seenUrls = new Set<string>();

  // Extract markdown links [text](url)
  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  
  while ((match = markdownLinkRegex.exec(text)) !== null) {
    const url = match[2];
    if (isValidUrl(url) && !seenUrls.has(url)) {
      citations.push(url);
      seenUrls.add(url);
    }
  }

  // Extract bare URLs (https://... or http://...) but exclude those inside markdown links
  const bareUrlRegex = /https?:\/\/[^\s<>"\]{}|\\^`)]+/g;
  while ((match = bareUrlRegex.exec(text)) !== null) {
    const url = match[0];
    if (isValidUrl(url) && !seenUrls.has(url)) {
      citations.push(url);
      seenUrls.add(url);
    }
  }

  // Clean up the text by removing "Sources:" sections and citation lists
  let cleanedText = text
    .replace(/\n\nSources?:\s*\n[\s\S]*$/, '') // Remove "Sources:" section at end
    .replace(/\n?-\s*\[([^\]]+)\]\([^)]+\)\s*/g, '') // Remove citation list items
    .trim();

  // For the cleaned text only, we want to preserve markdown links content but remove the URL part
  // This is for display purposes - we don't want to remove URLs from citation extraction
  cleanedText = cleanedText.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  
  // Also remove bare URLs from the display text and clean up extra spaces
  cleanedText = cleanedText
    .replace(/https?:\/\/[^\s<>"\]{}|\\^`)]+/g, '')
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .trim();

  return {
    cleanedText,
    citations
  };
}

/**
 * Validate if a string is a proper URL
 */
function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Convert Claude CLI result to OpenAI-compatible response format
 */
export function formatOpenAIResponse(
  claudeResult: ClaudeResult, 
  model: string
): OpenAIResponse {
  const { cleanedText, citations } = extractCitations(claudeResult.result);
  
  const response: OpenAIResponse = {
    id: `search-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: cleanedText
      },
      finish_reason: 'stop'
    }],
    citations,
    usage: {
      prompt_tokens: claudeResult.usage?.input_tokens ?? 0,
      completion_tokens: claudeResult.usage?.output_tokens ?? 0,
      total_tokens: claudeResult.usage?.total_tokens ?? 0
    }
  };

  return response;
}

/**
 * Extract search query from OpenAI messages array
 * Takes the last user message as the search query
 */
export function extractQuery(messages: Array<{ role: string; content: string }>): string {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages[i].content.trim();
    }
  }
  
  throw new Error('No user message found in request');
}

/**
 * Create error response in OpenAI format
 */
export function formatErrorResponse(message: string, type = 'internal_error'): { error: { message: string; type: string } } {
  return {
    error: {
      message,
      type
    }
  };
}