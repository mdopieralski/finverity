// Minimal YAML-frontmatter reader for agent and skill files: top-level `key: value` and folded
// `key: >-` blocks. Nested maps (hooks:) are kept as raw text under their key.
export function readFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) {
    return null;
  }
  const data = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (top) {
      key = top[1];
      const v = top[2].trim();
      data[key] = v === '>-' || v === '>' || v === '|' ? '' : v.replace(/^['"]|['"]$/g, '');
    } else if (key) {
      const t = line.trim();
      data[key] = data[key] ? `${data[key]}${/^- /.test(t) ? '\n' : ' '}${t}` : t;
    }
  }
  return { data, body: text.slice(m[0].length) };
}

export function listField(value = '') {
  return value
    .split(/[\n,]/)
    .map((s) => s.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}
