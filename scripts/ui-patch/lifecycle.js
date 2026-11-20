const path = require('node:path');
const { backupPathFor, readBundle, readRollbackData, readVerifiedBackup, replaceBundles } = require('./bundle-io');
const { reattachFooter } = require('./markers');
const { patchSessions, patchWorkbench } = require('./patch-bundles');

function getTargets(vsOutDir) {
  return [
    {
      name: 'sessions.desktop.main.js',
      filePath: path.join(vsOutDir, 'sessions', 'sessions.desktop.main.js'),
      patcher: patchSessions,
    },
    {
      name: 'workbench.desktop.main.js',
      filePath: path.join(vsOutDir, 'workbench', 'workbench.desktop.main.js'),
      patcher: patchWorkbench,
    },
  ];
}

function runCheck(vsOutDir) {
  let allHealthy = true;
  const appliedStates = new Set();
  for (const target of getTargets(vsOutDir)) {
    let status = target.name;
    try {
      const bundle = readBundle(target);
      const { blockCount, legacy } = bundle.patch;
      appliedStates.add(blockCount > 0);
      status += blockCount ? `: patched (${legacy ? 'legacy' : 'v1'}, markers=${blockCount})` : ': unpatched';
      const { hasBackup } = readRollbackData(bundle);
      const result = target.patcher(bundle.patch);
      if (!result.ok) throw new Error(result.reason);
      if (blockCount && bundle.text !== result.content) {
        throw new Error('Patch differs from the current output. Run --apply to update or --unpatch to restore.');
      }
      if (blockCount && !hasBackup) {
        throw new Error('Backup missing. Run --apply to recreate it or --unpatch to restore from the verified markers.');
      }
      console.log(`[patch-sessions-ui] OK ${status}, anchors verified, backup=${hasBackup ? 'verified' : 'none'}`);
    } catch (error) {
      allHealthy = false;
      console.warn(`[patch-sessions-ui] WARN ${status}: ${error.message}`);
    }
  }
  if (appliedStates.size > 1) {
    allHealthy = false;
    console.warn('[patch-sessions-ui] WARN Bundles are only partially patched. Run --apply or --unpatch to make them consistent.');
  }
  return allHealthy;
}

function runApply(vsOutDir) {
  const prepared = getTargets(vsOutDir).map((target) => {
    const bundle = readBundle(target);
    const result = target.patcher(bundle.patch);
    if (!result.ok) throw new Error(`${target.name}: ${result.reason}. Neither VS Code bundle was modified.`);
    const { original, hasBackup } = readRollbackData(bundle);
    const backupPath = backupPathFor(bundle);
    return {
      ...bundle,
      next: Buffer.from(result.content, 'utf8'),
      original,
      backupPath,
      hasBackup: bundle.patch.legacy ? readVerifiedBackup(backupPath, original) !== undefined : hasBackup,
    };
  });

  replaceBundles(prepared, { validateSyntax: true });
  for (const { raw, next, filePath } of prepared) {
    console.log(`[patch-sessions-ui] ${raw.equals(next) ? 'Already up to date' : 'Patched (v1)'}: ${filePath}`);
  }
}

function runUnpatch(vsOutDir) {
  const prepared = getTargets(vsOutDir).map((target) => {
    const bundle = readBundle(target);
    if (!bundle.patch.blockCount) return { ...bundle, next: bundle.raw };
    const { original, hasBackup } = readRollbackData(bundle);
    if (!hasBackup) {
      console.log(`[patch-sessions-ui] ${target.name}: Original bytes verified using patch markers (backup missing).`);
    }
    const next = bundle.patch.footer ? Buffer.from(reattachFooter(bundle.patch, original.toString('utf8'))) : original;
    return { ...bundle, next };
  });

  replaceBundles(prepared);
  for (const { filePath, patch } of prepared) {
    if (patch.footer && patch.blockCount) {
      console.log(`[patch-sessions-ui] Removed ${patch.blockCount} patch blocks and preserved BackgroundCover: ${filePath}`);
      continue;
    }
    const status = patch.blockCount ? `Restored original (${patch.blockCount} patch blocks removed)` : 'Already unpatched';
    console.log(`[patch-sessions-ui] ${status}: ${filePath}`);
  }
}

module.exports = { runApply, runCheck, runUnpatch };
