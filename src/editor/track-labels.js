function getLabelShape(rawName) {
  const soloed = rawName.length > 1 && rawName.startsWith('S');
  const body = soloed ? rawName.slice(1) : rawName;
  const muted = rawName.startsWith('_') || rawName.endsWith('_');
  const name = body.replace(/^_+/, '').replace(/_+$/, '');
  const muteStyle = !soloed && body.startsWith('_')
    ? 'prefix'
    : muted
      ? 'suffix'
      : null;
  return { name, muted, soloed, muteStyle };
}

function getLineCount(code) {
  if (!code.length) return 1;
  let lines = 1;
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '\n') lines++;
  }
  return lines;
}

function scanLabelAtLine(code, lineStart, line) {
  let i = lineStart;
  while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
  let lineEnd = code.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = code.length;
  const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(\s*):/.exec(code.slice(i, lineEnd));
  if (!match) return null;
  const rawName = match[1];
  const rawStart = i;
  const rawEnd = i + rawName.length;
  return {
    rawName,
    rawStart,
    rawEnd,
    line,
    col: rawStart - lineStart + 1,
    ...getLabelShape(rawName),
  };
}

function assignAnonymousNames(labels) {
  let anonymousIndex = 0;
  for (const label of labels) {
    if (label.name === '$') {
      label.anonymousIndex = anonymousIndex;
      label.displayName = `$${anonymousIndex + 1}`;
      anonymousIndex++;
    } else {
      label.anonymousIndex = null;
      label.displayName = label.name;
    }
  }
}

function finalizeRanges(labels, code) {
  const lineCount = getLineCount(code);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    const next = labels[i + 1];
    label.blockStart = label.rawStart;
    label.blockEnd = next ? next.rawStart : code.length;
    label.endLine = next ? next.line - 1 : lineCount;
  }
}

function findTargetLabel(labels, targetName) {
  for (const label of labels) {
    if (label.displayName === targetName) return label;
    if (label.name === targetName) return label;
    if (label.rawName === targetName) return label;
    if (label.name === '$') {
      if (targetName === `$${label.anonymousIndex}`) return label;
      if (targetName === '$' && label.anonymousIndex === 0) return label;
    }
  }
  return null;
}

function replaceLabelName(code, label, rawName) {
  return code.slice(0, label.rawStart) + rawName + code.slice(label.rawEnd);
}

export function parseLabels(code) {
  const labels = [];
  let line = 1;
  let lineStart = 0;
  let mode = 'code';
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let i = 0; i <= code.length; i++) {
    if (
      i === lineStart &&
      mode === 'code' &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      const label = scanLabelAtLine(code, lineStart, line);
      if (label) labels.push(label);
    }

    if (i >= code.length) break;

    const ch = code[i];
    const next = code[i + 1];

    if (mode === 'line-comment') {
      if (ch === '\n') {
        mode = 'code';
        line++;
        lineStart = i + 1;
      }
      continue;
    }

    if (mode === 'block-comment') {
      if (ch === '*' && next === '/') {
        mode = 'code';
        i++;
        continue;
      }
      if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      continue;
    }

    if (mode === 'single') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '\'') {
        mode = 'code';
      } else if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      continue;
    }

    if (mode === 'double') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') {
        mode = 'code';
      } else if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      continue;
    }

    if (mode === 'template') {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '`') {
        mode = 'code';
      } else if (ch === '\n') {
        line++;
        lineStart = i + 1;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      mode = 'line-comment';
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = 'block-comment';
      i++;
      continue;
    }
    if (ch === '\'') {
      mode = 'single';
      continue;
    }
    if (ch === '"') {
      mode = 'double';
      continue;
    }
    if (ch === '`') {
      mode = 'template';
      continue;
    }

    if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '\n') {
      line++;
      lineStart = i + 1;
    }
  }

  assignAnonymousNames(labels);
  finalizeRanges(labels, code);
  return labels;
}

export function labelAtLine(labels, line) {
  for (const label of labels) {
    if (line >= label.line && line <= label.endLine) {
      return label;
    }
  }
  return null;
}

export function toggleMute(code, labelName) {
  const labels = parseLabels(code);
  const label = findTargetLabel(labels, labelName);
  if (!label) {
    console.warn(`[strasbeat/track-labels] could not find label "${labelName}" for mute toggle`);
    return code;
  }
  const rawName = label.muted
    ? label.soloed
      ? `S${label.name}`
      : label.name
    : label.soloed
      ? `S${label.name}_`
      : `${label.name}_`;
  return replaceLabelName(code, label, rawName);
}

export function toggleSolo(code, labelName) {
  const labels = parseLabels(code);
  const label = findTargetLabel(labels, labelName);
  if (!label) {
    console.warn(`[strasbeat/track-labels] could not find label "${labelName}" for solo toggle`);
    return code;
  }
  const rawName = label.soloed
    ? label.muted
      ? `${label.name}_`
      : label.name
    : label.muted
      ? `S${label.name}_`
      : `S${label.name}`;
  return replaceLabelName(code, label, rawName);
}
