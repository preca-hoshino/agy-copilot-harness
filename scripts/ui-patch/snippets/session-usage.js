const { validateSnippetSyntax } = require('./validate');

function extractHistoryUsageParts(history, sessionResource) {
  if (sessionResource?.scheme !== 'antigravity' || !Array.isArray(history)) return;
  for (const turn of history) {
    if (turn?.type !== 'response' || !Array.isArray(turn.parts)) continue;
    for (let i = turn.parts.length - 1; i >= 0; i -= 1) {
      const value = turn.parts[i]?.content?.value;
      if (typeof value !== 'string') continue;
      const match = /^<!--AGY_USAGE:(\{[^>]+\})-->$/.exec(value.trim());
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[1]);
        if (typeof parsed?.used === 'number' && Number.isFinite(parsed.used) && parsed.used >= 0) {
          const part = { kind: 'usage', promptTokens: parsed.used, completionTokens: 0 };
          if (typeof parsed.size === 'number' && Number.isFinite(parsed.size) && parsed.size > 0) {
            part.contextUsage = { currentTokens: parsed.used, tokenLimit: parsed.size };
          }
          turn.parts.splice(i, 1, part);
        }
      } catch {
        // Ignore malformed markers.
      }
    }
  }
}

function buildSessionHistoryUsageSnippet() {
  const body = `,(${extractHistoryUsageParts.toString()})(this.history,this.sessionResource)`;
  const check = validateSnippetSyntax(body, '(function(){void(0', ');})', 'session history usage');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return body;
}

module.exports = { buildSessionHistoryUsageSnippet, extractHistoryUsageParts };
