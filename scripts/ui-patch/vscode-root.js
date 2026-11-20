const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isValidVsOutDir(candidate) {
  if (!candidate || !fs.existsSync(candidate)) {
    return false;
  }
  const sessionsJs = path.join(candidate, 'sessions', 'sessions.desktop.main.js');
  const workbenchJs = path.join(candidate, 'workbench', 'workbench.desktop.main.js');
  return fs.existsSync(sessionsJs) && fs.existsSync(workbenchJs);
}

function resolveFromInstallDir(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) {
    return null;
  }
  if (isValidVsOutDir(baseDir)) {
    return baseDir;
  }
  const directVs = path.join(baseDir, 'resources', 'app', 'out', 'vs');
  if (isValidVsOutDir(directVs)) {
    return directVs;
  }

  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidateVs = path.join(baseDir, entry.name, 'resources', 'app', 'out', 'vs');
    if (isValidVsOutDir(candidateVs)) {
      try {
        const stat = fs.statSync(path.join(candidateVs, 'workbench', 'workbench.desktop.main.js'));
        candidates.push({ dir: candidateVs, mtimeMs: stat.mtimeMs });
      } catch {
        candidates.push({ dir: candidateVs, mtimeMs: 0 });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].dir;
}

function detectVsCodeOutDir(explicitRoot) {
  if (explicitRoot) {
    const resolved = resolveFromInstallDir(path.resolve(explicitRoot));
    return resolved;
  }

  const roots = [];
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const programFilesX86 = process.env['ProgramFiles(x86)'];

  roots.push(path.join(programFiles, 'Microsoft VS Code'));
  roots.push(path.join(localAppData, 'Programs', 'Microsoft VS Code'));
  if (programFilesX86) {
    roots.push(path.join(programFilesX86, 'Microsoft VS Code'));
  }
  roots.push(path.join(programFiles, 'Microsoft VS Code Insiders'));
  roots.push(path.join(localAppData, 'Programs', 'Microsoft VS Code Insiders'));

  for (const root of roots) {
    const resolved = resolveFromInstallDir(root);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

module.exports = { detectVsCodeOutDir };
