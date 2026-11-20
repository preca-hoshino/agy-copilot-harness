const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { inspectPatch, reattachFooter } = require('./markers');

function readBundle(target) {
  const stat = fs.lstatSync(target.filePath);
  if (!stat.isFile()) throw new Error(`Expected a regular bundle file: ${target.filePath}`);
  const raw = fs.readFileSync(target.filePath);
  const text = raw.toString('utf8');
  if (!raw.equals(Buffer.from(text, 'utf8'))) {
    throw new Error(`${target.name}: Bundle is not valid UTF-8.`);
  }
  const patch = inspectPatch(text);
  if (!patch.ok) throw new Error(`${target.name}: ${patch.reason}`);
  return { ...target, raw, text, patch, mode: stat.mode & 0o777 };
}

function backupPathFor(bundle) {
  return `${bundle.filePath}.agy-harness-${bundle.patch.baseHash}.bak`;
}

function readVerifiedBackup(filePath, original) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Expected a regular backup file: ${filePath}`);
  const backup = fs.readFileSync(filePath);
  if (!backup.equals(original)) {
    throw new Error(`Backup does not match the original bundle: ${filePath}. Refusing to overwrite it or use it for rollback.`);
  }
  return backup;
}

function readRollbackData(bundle) {
  const original = Buffer.from(bundle.patch.clean, 'utf8');
  const backupPath = bundle.patch.legacy ? `${bundle.filePath}.bak` : backupPathFor(bundle);
  const expectedBackup = bundle.patch.legacy
    ? Buffer.from(reattachFooter(bundle.patch, bundle.patch.clean), 'utf8')
    : original;
  const backup = readVerifiedBackup(backupPath, expectedBackup);
  if (bundle.patch.legacy && !backup) {
    throw new Error(`${bundle.name}: Legacy patch has no matching backup (${backupPath}). Repair or reinstall VS Code before retrying.`);
  }
  return { original, hasBackup: backup !== undefined };
}

function checkBundleSyntax(filePath, bundleName) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
    maxBuffer: 128 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = /^SyntaxError:[^\r\n]*/m.exec(result.stderr ?? '')?.[0] ?? result.error?.message ?? `exit ${result.status}`;
    throw new Error(`Syntax validation failed for ${bundleName}: ${detail}`);
  }
}

function assertBundleUnchanged(filePath, expected) {
  if (!fs.lstatSync(filePath).isFile() || !fs.readFileSync(filePath).equals(expected)) {
    throw new Error(`Bundle changed during the operation: ${filePath}`);
  }
}

function createBackup(filePath, original, mode) {
  const fd = fs.openSync(filePath, 'wx', mode);
  try {
    try {
      fs.writeFileSync(fd, original, { flush: true });
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    try {
      fs.unlinkSync(filePath);
    } catch (cleanupError) {
      console.warn(`[patch-sessions-ui] Could not remove incomplete backup ${filePath}: ${cleanupError.message}`);
    }
    throw error;
  }
  console.log(`[patch-sessions-ui] Backup created: ${filePath}`);
}

function replaceBundles(prepared, { validateSyntax = false } = {}) {
  const staged = [];
  const replaced = [];
  const keep = new Set();
  try {
    for (const change of prepared) {
      if (change.raw.equals(change.next)) continue;
      const directory = fs.mkdtempSync(path.join(path.dirname(change.filePath), '.agy-ui-'));
      const nextPath = path.join(directory, 'next.mjs');
      const rollbackPath = path.join(directory, 'previous.mjs');
      staged.push({ ...change, directory, nextPath, rollbackPath });
      fs.writeFileSync(nextPath, change.next, { mode: change.mode, flag: 'wx', flush: true });
      if (validateSyntax) checkBundleSyntax(nextPath, change.name);
      fs.writeFileSync(rollbackPath, change.raw, { mode: change.mode, flag: 'wx', flush: true });
    }
    // Validate and back up both bundles before the first replacement.
    for (const change of prepared) {
      assertBundleUnchanged(change.filePath, change.raw);
    }
    for (const { backupPath, hasBackup, original, mode } of prepared) {
      if (backupPath && !hasBackup) createBackup(backupPath, original, mode);
    }
    for (const change of staged) {
      assertBundleUnchanged(change.filePath, change.raw);
      fs.renameSync(change.nextPath, change.filePath);
      replaced.push(change);
    }
  } catch (error) {
    for (const change of replaced.reverse()) {
      try {
        assertBundleUnchanged(change.filePath, change.next);
        fs.renameSync(change.rollbackPath, change.filePath);
      } catch (rollbackError) {
        keep.add(change.directory);
        console.error(`[patch-sessions-ui] Could not undo replacement of ${change.filePath}: ${rollbackError.message}. Previous file kept at ${change.rollbackPath}`);
      }
    }
    throw error;
  } finally {
    for (const { directory } of staged) {
      if (keep.has(directory)) continue;
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[patch-sessions-ui] Could not remove staging directory ${directory}: ${error.message}`);
      }
    }
  }
}

module.exports = { backupPathFor, readBundle, readRollbackData, readVerifiedBackup, replaceBundles };
