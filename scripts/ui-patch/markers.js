const { createHash } = require('node:crypto');

const PATCH_START = '/*AGY_HARNESS_PATCH_START';
const PATCH_END = '/*AGY_HARNESS_PATCH_END';
const MARKER_PREFIX = /\/\*AGY_HARNESS_PATCH_(?:START|END)/g;
const MARKER_BLOCK =
  /\/\*AGY_HARNESS_PATCH_START(?<tag>:v1:(?<hook>[a-z-]+):(?<baseHash>[a-f0-9]{64}):(?<snippetHash>[a-f0-9]{64}))?\*\/(?<snippet>[\s\S]*?)\/\*AGY_HARNESS_PATCH_END\k<tag>\*\//g;
const BACKGROUND_START = '/*ext-backgroundCover-start*/';
const BACKGROUND_END = '/*ext-backgroundCover-end*/';
const BACKGROUND_BOOTSTRAP = /^\s*\/\*ext\.backgroundCover\.bootstrap\.1\*\//;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function separateBackgroundFooter(content) {
  const start = content.indexOf(BACKGROUND_START);
  const end = content.indexOf(BACKGROUND_END);
  if (start === -1 && end === -1) return { ok: true, body: content, footer: '' };
  if (
    start === -1 ||
    end < start ||
    content.indexOf(BACKGROUND_START, start + 1) !== -1 ||
    !/^\s*$/.test(content.slice(end + BACKGROUND_END.length)) ||
    !BACKGROUND_BOOTSTRAP.test(content.slice(start + BACKGROUND_START.length, end))
  ) {
    return { ok: false, reason: 'Unrecognized BackgroundCover footer; refusing to modify the bundle.' };
  }
  return { ok: true, body: content.slice(0, start), footer: content.slice(start) };
}

function inspectPatch(content) {
  const background = separateBackgroundFooter(content);
  if (!background.ok) return background;
  const { body, footer } = background;
  if (footer.search(MARKER_PREFIX) !== -1) {
    return { ok: false, reason: 'Antigravity patch markers overlap the BackgroundCover footer.' };
  }

  const markerCount = body.match(MARKER_PREFIX)?.length ?? 0;
  const blocks = [...body.matchAll(MARKER_BLOCK)];
  if (blocks.length * 2 !== markerCount) {
    return { ok: false, reason: 'Malformed or unsupported Antigravity patch markers; refusing to modify the bundle.' };
  }

  const code = blocks.length ? body.replace(MARKER_BLOCK, '') : body;
  const blockCount = blocks.length;
  const expectedHash = blocks[0]?.groups.baseHash;
  const legacy = blockCount > 0 && !expectedHash;
  const hooks = new Set();
  for (const { groups } of blocks) {
    if (legacy !== !groups.tag) {
      return { ok: false, reason: 'Mixed legacy and versioned patch markers; refusing to modify the bundle.' };
    }
    if (legacy) continue;
    if (groups.baseHash !== expectedHash) {
      return { ok: false, reason: 'Patch markers disagree on the original bundle SHA-256.' };
    }
    if (hooks.has(groups.hook) || groups.snippetHash !== sha256(groups.snippet)) {
      return { ok: false, reason: `Duplicate or modified patch block: ${groups.hook}.` };
    }
    hooks.add(groups.hook);
  }

  const baseHash = sha256(code);
  if (expectedHash && baseHash !== expectedHash) {
    // BackgroundCover can replace the original terminal newline with its footer.
    const lineEnding = footer && ['\n', '\r\n'].find((ending) => sha256(code + ending) === expectedHash);
    if (!lineEnding) {
      return { ok: false, reason: 'Bundle outside patch markers no longer matches the original SHA-256.' };
    }
    return {
      ok: true,
      clean: code + lineEnding,
      footer,
      omittedLineEnding: lineEnding.length,
      baseHash: expectedHash,
      legacy,
      blockCount,
    };
  }

  return { ok: true, clean: code, footer, omittedLineEnding: 0, baseHash, legacy, blockCount };
}

function reattachFooter(patch, content) {
  return patch.footer ? content.slice(0, content.length - patch.omittedLineEnding) + patch.footer : content;
}

function markSnippet(hook, baseHash, snippet) {
  const body = snippet.replace(/\r\n/g, '\n');
  const tag = `:v1:${hook}:${baseHash}:${sha256(body)}`;
  return `${PATCH_START}${tag}*/${body}${PATCH_END}${tag}*/`;
}

function stripPatchMarkers(content) {
  const patch = inspectPatch(content);
  if (!patch.ok) throw new Error(patch.reason);
  return reattachFooter(patch, patch.clean);
}

module.exports = {
  PATCH_START: `${PATCH_START}*/`,
  PATCH_END: `${PATCH_END}*/`,
  inspectPatch,
  markSnippet,
  reattachFooter,
  stripPatchMarkers,
};
