#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyEdits, modify, parse } = require('jsonc-parser');

const DEFAULT_EXTENSION_ID = 'antigravity.agy-copilot-harness';
const ARGV_PROPOSED_API_KEY = 'enable-proposed-api';

function getDefaultArgvPath() {
  return path.join(os.homedir(), '.vscode', 'argv.json');
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detectFormattingOptions(content) {
  const usesTabs = /(?:^|\n)\t/.test(content);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  if (usesTabs) {
    return { tabSize: 4, insertSpaces: false, eol };
  }
  const spaceIndentMatch = /\n( +)"/.exec(content);
  const detectedSpaces = spaceIndentMatch?.[1] ? spaceIndentMatch[1].length : 2;
  return {
    tabSize: detectedSpaces === 4 ? 4 : 2,
    insertSpaces: true,
    eol,
  };
}

function getProposedApiValue(content) {
  const errors = [];
  const parsed = parse(content, errors, { allowTrailingComma: true });
  if (!isPlainRecord(parsed)) {
    return undefined;
  }
  return parsed[ARGV_PROPOSED_API_KEY];
}

function hasProposedApiInArgvContent(content, extensionId) {
  const target = extensionId.trim().toLowerCase();
  if (!target) {
    return false;
  }
  const rawValue = getProposedApiValue(content);
  if (typeof rawValue === 'string') {
    return rawValue.toLowerCase() === target;
  }
  if (Array.isArray(rawValue)) {
    return rawValue.some((item) => typeof item === 'string' && item.toLowerCase() === target);
  }
  return false;
}

function ensureProposedApiInArgvContent(content, extensionId) {
  const trimmedId = extensionId.trim();
  if (!trimmedId) {
    return { changed: false, content };
  }

  const rawValue = getProposedApiValue(content);
  const formattingOptions = detectFormattingOptions(content);
  let edits;

  if (typeof rawValue === 'string') {
    if (rawValue.toLowerCase() === trimmedId.toLowerCase()) {
      return { changed: false, content };
    }
    edits = modify(content, [ARGV_PROPOSED_API_KEY], [rawValue, trimmedId], { formattingOptions });
  } else if (Array.isArray(rawValue)) {
    if (rawValue.some((item) => typeof item === 'string' && item.toLowerCase() === trimmedId.toLowerCase())) {
      return { changed: false, content };
    }
    edits = modify(content, [ARGV_PROPOSED_API_KEY, -1], trimmedId, {
      isArrayInsertion: true,
      formattingOptions,
    });
  } else {
    edits = modify(content, [ARGV_PROPOSED_API_KEY], [trimmedId], { formattingOptions });
  }

  const nextContent = applyEdits(content, edits);
  if (nextContent === content) {
    return { changed: false, content };
  }
  return { changed: true, content: nextContent };
}

function removeProposedApiFromArgvContent(content, extensionId) {
  const trimmedId = extensionId.trim();
  if (!trimmedId) {
    return { changed: false, content };
  }

  const target = trimmedId.toLowerCase();
  const rawValue = getProposedApiValue(content);
  const formattingOptions = detectFormattingOptions(content);

  if (typeof rawValue === 'string') {
    if (rawValue.toLowerCase() !== target) {
      return { changed: false, content };
    }
    const edits = modify(content, [ARGV_PROPOSED_API_KEY], undefined, { formattingOptions });
    const nextContent = applyEdits(content, edits);
    return { changed: nextContent !== content, content: nextContent };
  }

  if (Array.isArray(rawValue)) {
    const matchingIndices = [];
    for (let i = 0; i < rawValue.length; i += 1) {
      const item = rawValue[i];
      if (typeof item === 'string' && item.toLowerCase() === target) {
        matchingIndices.push(i);
      }
    }
    if (matchingIndices.length === 0) {
      return { changed: false, content };
    }

    let current = content;
    if (matchingIndices.length === rawValue.length) {
      const edits = modify(current, [ARGV_PROPOSED_API_KEY], undefined, { formattingOptions });
      current = applyEdits(current, edits);
    } else {
      for (let i = matchingIndices.length - 1; i >= 0; i -= 1) {
        const indexToRemove = matchingIndices[i];
        const edits = modify(current, [ARGV_PROPOSED_API_KEY, indexToRemove], undefined, { formattingOptions });
        current = applyEdits(current, edits);
      }
    }
    return { changed: current !== content, content: current };
  }

  return { changed: false, content };
}

function parseArgs(argv) {
  const options = {
    argvPath: getDefaultArgvPath(),
    extensionId: DEFAULT_EXTENSION_ID,
    check: false,
    remove: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--remove') {
      options.remove = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--argv') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --argv');
      }
      options.argvPath = path.resolve(next);
      i += 1;
    } else if (arg.startsWith('--argv=')) {
      options.argvPath = path.resolve(arg.slice('--argv='.length));
    } else if (arg === '--id') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --id');
      }
      options.extensionId = next;
      i += 1;
    } else if (arg.startsWith('--id=')) {
      options.extensionId = arg.slice('--id='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.check && options.remove) {
    throw new Error('Cannot combine --check and --remove.');
  }

  return options;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/patch-argv.js [options]',
      '',
      'Options:',
      `  --argv <path>   Path to argv.json (default: ${getDefaultArgvPath()})`,
      `  --id <extId>    Extension ID to enable (default: ${DEFAULT_EXTENSION_ID})`,
      '  --check         Exit 0 if enabled, 1 if missing (does not modify file)',
      '  --remove        Remove extension ID from enable-proposed-api',
      '  -h, --help      Show this help message',
    ].join('\n'),
  );
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[patch-argv] ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  const fileExists = fs.existsSync(options.argvPath);
  const existingContent = fileExists ? fs.readFileSync(options.argvPath, 'utf8') : '';

  if (options.check) {
    if (!fileExists) {
      console.log(`[patch-argv] NOT ENABLED: ${options.argvPath} does not exist.`);
      process.exitCode = 1;
      return;
    }
    const enabled = hasProposedApiInArgvContent(existingContent, options.extensionId);
    if (enabled) {
      console.log(`[patch-argv] ENABLED: "${options.extensionId}" is present in ${options.argvPath}.`);
      return;
    }
    console.log(`[patch-argv] NOT ENABLED: "${options.extensionId}" is missing from ${options.argvPath}.`);
    process.exitCode = 1;
    return;
  }

  if (options.remove) {
    if (!fileExists) {
      console.log(`[patch-argv] No-op: ${options.argvPath} does not exist.`);
      return;
    }
    const result = removeProposedApiFromArgvContent(existingContent, options.extensionId);
    if (!result.changed) {
      console.log(`[patch-argv] No-op: "${options.extensionId}" is not in ${options.argvPath}.`);
      return;
    }
    fs.writeFileSync(options.argvPath, result.content, 'utf8');
    console.log(`[patch-argv] Removed "${options.extensionId}" from ${options.argvPath}.`);
    return;
  }

  const result = ensureProposedApiInArgvContent(existingContent, options.extensionId);
  if (!result.changed) {
    console.log(`[patch-argv] Already enabled: "${options.extensionId}" in ${options.argvPath}.`);
    return;
  }

  fs.mkdirSync(path.dirname(options.argvPath), { recursive: true });
  fs.writeFileSync(options.argvPath, result.content, 'utf8');
  console.log(`[patch-argv] Enabled "${options.extensionId}" in ${options.argvPath}.`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_EXTENSION_ID,
  getDefaultArgvPath,
  hasProposedApiInArgvContent,
  ensureProposedApiInArgvContent,
  removeProposedApiFromArgvContent,
};
