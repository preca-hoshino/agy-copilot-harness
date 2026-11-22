const { validateSnippetSyntax } = require('./validate');

function extractHistoryUsageParts(history, sessionResource) {
  if (sessionResource?.scheme !== 'antigravity' || !Array.isArray(history)) return;
  const parseUri =
    typeof sessionResource?.constructor?.parse === 'function'
      ? (raw) => {
          try {
            return sessionResource.constructor.parse(raw);
          } catch {
            return undefined;
          }
        }
      : undefined;
  for (const turn of history) {
    if (turn?.type !== 'response' || !Array.isArray(turn.parts)) continue;
    for (let i = turn.parts.length - 1; i >= 0; i -= 1) {
      const current = turn.parts[i];
      if (
        parseUri &&
        current?.kind === 'toolInvocationSerialized' &&
        current.isComplete !== false &&
        !current.resultError &&
        typeof current.toolSpecificData?.uri === 'string' &&
        current.toolSpecificData.agyEdit !== false
      ) {
        const rawEntries =
          Array.isArray(current.toolSpecificData.changes) && current.toolSpecificData.changes.length > 0
            ? current.toolSpecificData.changes
            : [current.toolSpecificData];
        const edits = [];
        for (const entry of rawEntries) {
          if (typeof entry?.uri !== 'string') continue;
          const parsedUri = parseUri(entry.uri);
          if (!parsedUri) continue;
          edits.push({
            kind: 'externalEdit',
            uri: parsedUri,
            editKind: entry.editKind === 'create' ? 'create' : 'edit',
            diff: {
              added: typeof entry.insertions === 'number' ? entry.insertions : 0,
              removed: typeof entry.deletions === 'number' ? entry.deletions : 0,
            },
            afterContentUri: parsedUri,
            undoStopId: current.toolCallId,
            ...(current.subAgentInvocationId !== undefined ? { subAgentInvocationId: current.subAgentInvocationId } : {}),
          });
        }
        if (edits.length > 0) {
          current.presentation = 'hidden';
          turn.parts.splice(i + 1, 0, ...edits);
          continue;
        }
      }
      const value = current?.content?.value;
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
