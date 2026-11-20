#!/usr/bin/env node

const { runApply, runCheck, runUnpatch } = require('./ui-patch/lifecycle');
const { detectVsCodeOutDir } = require('./ui-patch/vscode-root');

function parseArgs(argv) {
  const options = {
    mode: null,
    vscodeRoot: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      if (options.mode && options.mode !== 'apply') {
        throw new Error('Specify only one of --apply, --check, or --unpatch.');
      }
      options.mode = 'apply';
    } else if (arg === '--check') {
      if (options.mode && options.mode !== 'check') {
        throw new Error('Specify only one of --apply, --check, or --unpatch.');
      }
      options.mode = 'check';
    } else if (arg === '--unpatch') {
      if (options.mode && options.mode !== 'unpatch') {
        throw new Error('Specify only one of --apply, --check, or --unpatch.');
      }
      options.mode = 'unpatch';
    } else if (arg === '--vscode-root' || arg.startsWith('--vscode-root=')) {
      const root = arg === '--vscode-root' ? argv[++i] : arg.slice('--vscode-root='.length);
      if (!root?.trim() || root.startsWith('--')) {
        throw new Error('Missing path for --vscode-root.');
      }
      options.vscodeRoot = root;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(
    [
      'Usage: node scripts/patch-sessions-ui.js (--apply | --check | --unpatch) [--vscode-root <path>]',
      '',
      'Options:',
      '  --apply                Back up and patch both VS Code UI bundles with versioned markers',
      '  --check                Verify anchors, patch status, and backups (read-only)',
      '  --unpatch              Remove only Antigravity patches and retain backups',
      '  --vscode-root <path>   Explicit VS Code install, version hash, or out/vs directory',
      '  -h, --help             Show this help message',
    ].join('\n'),
  );
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[patch-sessions-ui] ${error instanceof Error ? error.message : String(error)}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.help || !options.mode) {
    printUsage();
    if (!options.help) {
      process.exitCode = 1;
    }
    return;
  }

  const vsOutDir = detectVsCodeOutDir(options.vscodeRoot);
  if (!vsOutDir) {
    console.warn(
      '[patch-sessions-ui] Could not locate VS Code out/vs directory (sessions.desktop.main.js & workbench.desktop.main.js). Pass --vscode-root <path>.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[patch-sessions-ui] Target VS Code out/vs: ${vsOutDir}`);

  try {
    if (options.mode === 'check') {
      if (!runCheck(vsOutDir)) process.exitCode = 1;
    } else if (options.mode === 'apply') {
      runApply(vsOutDir);
    } else {
      runUnpatch(vsOutDir);
    }
  } catch (error) {
    console.error(`[patch-sessions-ui] ${error.message}`);
    if (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EBUSY') {
      console.error('[patch-sessions-ui] Close VS Code and retry. If the install directory requires elevation, use an Administrator PowerShell.');
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
} else {
  const { PATCH_START, PATCH_END, inspectPatch, stripPatchMarkers } = require('./ui-patch/markers');
  const { patchSessions, patchWorkbench } = require('./ui-patch/patch-bundles');
  const { renderQuotaGroups, renderQuotaRow } = require('./ui-patch/snippets/quota-rendering');
  const { createTerminalApproval } = require('./ui-patch/snippets/terminal-approval');

  module.exports = {
    PATCH_START,
    PATCH_END,
    detectVsCodeOutDir,
    stripPatchMarkers,
    createTerminalApproval,
    renderQuotaRow,
    renderQuotaGroups,
    patchSessionsContent: (content) => patchSessions(inspectPatch(content)),
    patchWorkbenchContent: (content) => patchWorkbench(inspectPatch(content)),
  };
}
