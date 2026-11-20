const vm = require('node:vm');

function validateSnippetSyntax(code, wrapperPrefix, wrapperSuffix, label) {
  try {
    new vm.Script(`${wrapperPrefix}${code}${wrapperSuffix}`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Syntax validation failed for ${label}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

module.exports = { validateSnippetSyntax };
