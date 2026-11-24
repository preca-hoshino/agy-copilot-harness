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
        if (!parsed || typeof parsed !== 'object') continue;
        if (typeof parsed.elapsedMs === 'number' && Number.isFinite(parsed.elapsedMs) && parsed.elapsedMs >= 0) {
          turn.elapsedMs = parsed.elapsedMs;
        }
        if (typeof parsed.completedAt === 'number' && Number.isFinite(parsed.completedAt) && parsed.completedAt >= 0) {
          turn.completedAt = parsed.completedAt;
        }
        if (typeof parsed.responseDetails === 'string' && parsed.responseDetails.length > 0 && !turn.details) {
          turn.details = parsed.responseDetails;
        }
        let validModelTotals;
        if (Array.isArray(parsed.modelTotals) && parsed.modelTotals.length > 0) {
          const filteredTotals = parsed.modelTotals.filter(
            (entry) =>
              typeof entry?.model === 'string' &&
              entry.model.length > 0 &&
              typeof entry?.inputTokens === 'number' &&
              Number.isFinite(entry.inputTokens) &&
              typeof entry?.cachedTokens === 'number' &&
              Number.isFinite(entry.cachedTokens) &&
              typeof entry?.outputTokens === 'number' &&
              Number.isFinite(entry.outputTokens),
          );
          if (filteredTotals.length > 0) {
            validModelTotals = filteredTotals;
          }
        }
        if (typeof parsed.used === 'number' && Number.isFinite(parsed.used) && parsed.used >= 0) {
          const completion =
            typeof parsed.completionTokens === 'number' &&
            Number.isFinite(parsed.completionTokens) &&
            parsed.completionTokens >= 0
              ? Math.min(parsed.used, parsed.completionTokens)
              : 0;
          if (parsed.used === 0 && completion === 0 && !validModelTotals) {
            turn.parts.splice(i, 1);
            continue;
          }
          const part = {
            kind: 'usage',
            promptTokens: Math.max(0, parsed.used - completion),
            completionTokens: completion,
          };
          if (typeof parsed.size === 'number' && Number.isFinite(parsed.size) && parsed.size > 0) {
            part.contextUsage = { currentTokens: parsed.used, tokenLimit: parsed.size };
          }
          if (validModelTotals) {
            part.modelTotals = validModelTotals;
          }
          if (Array.isArray(parsed.details) && parsed.details.length > 0) {
            const details = parsed.details.filter(
              (detail) =>
                typeof detail?.category === 'string' &&
                typeof detail?.label === 'string' &&
                typeof detail?.percentageOfPrompt === 'number' &&
                Number.isFinite(detail.percentageOfPrompt) &&
                detail.percentageOfPrompt > 0,
            );
            if (details.length > 0) {
              part.promptTokenDetails = details;
            }
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

function applyLiveTurnStats(request, result) {
  const stats = result?.metadata?.__agyTurnStats;
  const response = request?.response;
  if (!stats || !response) return;
  if (typeof stats.elapsedMs === 'number' && Number.isFinite(stats.elapsedMs) && stats.elapsedMs >= 0) {
    response.setElapsedMs?.(stats.elapsedMs);
  }
  if (typeof stats.completedAt === 'number' && Number.isFinite(stats.completedAt) && stats.completedAt >= 0) {
    response._completionTimestamp = stats.completedAt;
  }
  if (Array.isArray(stats.modelTotals) && stats.modelTotals.length > 0) {
    const prevUsage = response.usage?.get?.() ?? response._usageObs?.get?.();
    const nextUsage = prevUsage
      ? { ...prevUsage, modelTotals: stats.modelTotals }
      : {
          kind: 'usage',
          promptTokens: 0,
          completionTokens: stats.modelTotals.reduce(
            (sum, item) => sum + (typeof item?.outputTokens === 'number' ? item.outputTokens : 0),
            0,
          ),
          modelTotals: stats.modelTotals,
        };
    if (typeof response.setUsage === 'function') {
      response.setUsage(nextUsage);
    } else {
      response._usageObs?.set?.(nextUsage, void 0);
    }
  }
}

function buildLiveTurnStatsSnippet({ req, res }) {
  const body = `(${applyLiveTurnStats.toString()})(${req},${res}),`;
  const check = validateSnippetSyntax(body, '(function(){', 'void 0;})', 'live turn stats');
  if (!check.ok) {
    throw new Error(check.reason);
  }
  return body;
}

module.exports = {
  applyLiveTurnStats,
  buildLiveTurnStatsSnippet,
  buildSessionHistoryUsageSnippet,
  extractHistoryUsageParts,
};
