function renderQuotaRow(parent, pool) {
  const add = (target, className, text) => {
    const node = target.ownerDocument.createElement('div');
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return target.appendChild(node);
  };
  const percent = Number.isFinite(pool.usedPercent) ? Math.round(Math.max(0, Math.min(100, pool.usedPercent))) : undefined;
  const row = add(parent, 'agy-quota-row');
  row.style.cssText = 'display:grid;gap:5px;margin-block:8px 4px;min-width:0';
  const header = add(row, 'agy-quota-header');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:2px 12px';
  const timing = [pool.windowLabel, pool.resetLabel].filter(Boolean).join(' · ');
  add(header, 'agy-quota-timing', timing || 'Quota').style.cssText = 'flex:1 1 10em;color:var(--vscode-descriptionForeground)';
  const value = add(header, 'agy-quota-value');
  value.style.cssText = 'margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums';
  if (percent === undefined) {
    value.textContent = 'Usage unavailable';
  } else {
    const number = value.ownerDocument.createElement('strong');
    number.style.cssText = 'font-size:1.65em;line-height:1.15';
    number.textContent = `${percent}%`;
    value.append(number, ' used');
  }
  if (percent !== undefined) {
    const track = add(row, 'agy-quota-track');
    track.setAttribute('aria-hidden', 'true');
    track.style.cssText = 'direction:ltr;display:block;width:100%;height:4px;overflow:hidden;border-radius:2px;background:var(--vscode-editorWidget-border,#7776)';
    const fill = add(track, 'agy-quota-fill');
    fill.style.cssText = 'display:block;height:100%;background:var(--vscode-progressBar-background,#3794ff)';
    fill.style.width = `${percent}%`;
  }
  return row;
}

function renderQuotaGroups(parent, pools, renderRow, onRow) {
  const groups = new Map();
  for (const pool of pools) {
    const label = pool.label || 'Quota';
    let group = groups.get(label);
    if (!group) {
      group = parent.ownerDocument.createElement('section');
      group.className = 'agy-quota-group';
      group.style.marginBlock = '12px 4px';
      const title = parent.ownerDocument.createElement('h3');
      title.className = 'agy-quota-name';
      title.style.cssText = 'font-size:1.25em;font-weight:600;margin:0;overflow-wrap:anywhere';
      title.textContent = label;
      group.appendChild(title);
      parent.appendChild(group);
      groups.set(label, group);
    }
    onRow(renderRow(group, pool), pool);
  }
}

module.exports = { renderQuotaGroups, renderQuotaRow };
