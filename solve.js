// Fast static-site builder: same answers as makefun-site 1.0.0, written from the
// spec (README) and the reference's observable behaviour. Dependency-free ES module.
// Speed levers: single-pass Markdown with run-based escaping, ASCII fast-path slugify
// with a per-case memo, templates compiled to JS functions, no token objects.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- text -------------------------------------------------------------------

const ESC_RE = /[&<>"']/;

/** HTML-escape: fast path returns the input untouched when nothing needs escaping. */
function esc(s) {
  if (!ESC_RE.test(s)) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let e = null;
    if (c === '&') e = '&amp;';
    else if (c === '<') e = '&lt;';
    else if (c === '>') e = '&gt;';
    else if (c === '"') e = '&quot;';
    else if (c === "'") e = '&#39;';
    if (e !== null) { out += s.slice(last, i) + e; last = i + 1; }
  }
  return out + s.slice(last);
}

/**
 * Slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of other
 * characters one `-`, none at either end, cut to 64 (a `-` left at the cut dropped),
 * `untitled` when nothing is left. Pure-ASCII input takes a one-pass shortcut
 * (NFKD is the identity on ASCII); anything else goes through the full path.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let buf = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) { ascii = false; break; }
    let keep = null;
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = text[i];
    if (keep === null) { gap = buf.length > 0; continue; }
    if (gap) buf += '-';
    gap = false;
    buf += keep;
  }
  if (!ascii) {
    buf = '';
    gap = false;
    const feed = (ch) => {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = buf.length > 0; return; }
      if (gap) buf += '-';
      gap = false;
      buf += keep;
    };
    for (const ch of text.normalize('NFKD').replace(/\p{M}/gu, '')) feed(ch);
  }
  let out = buf.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** JS \s code units, as a table (charCode -> 1). */
const WS_TABLE = (() => {
  const t = new Uint8Array(65536);
  for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196,
    8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) t[c] = 1;
  return t;
})();

/** Word count: runs of non-whitespace (JS \s), counted by a table-driven scan. */
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inW = false;
    else if (!inW) {
      inW = true;
      n++;
    }
  }
  return n;
}

/** `rel` from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// --- front matter -----------------------------------------------------------

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or a bare string. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false }
        : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Finds the closing `---` line
 * by substring search instead of splitting the whole file into lines.
 */
function parseFM(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let regionEnd;
  let body;
  const cs = text.indexOf('\n---\n', 3);
  if (cs !== -1) {
    regionEnd = cs;
    body = text.slice(cs + 5);
  } else if (text.endsWith('\n---')) {
    regionEnd = text.length - 4;
    body = '';
  } else {
    return { error: 'the front matter is not closed' };
  }
  const region = text.slice(4, regionEnd);
  const data = {};
  if (region !== '') {
    const lines = region.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (/^[ \t]*$/.test(line) || line[0] === '#') continue;
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${j + 2} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// --- Markdown ---------------------------------------------------------------

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const WS_RUN = /\s/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsPara(line) {
  if (line.length === 0) return true;
  const c0 = line[0];
  if (c0 === ' ' || c0 === '\t') return isBlank(line);
  if (c0 === '`' && FENCE_OPEN.test(line)) return true;
  if (c0 === '#' && headingOf(line) !== null) return true;
  if ((c0 === '-' || c0 === '*') && HR.test(line)) return true;
  return false;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** Whether the char at `j` is escaped: the run of backslashes ending at j-1,
 * counted from `from` (the old scan pairs escapes starting at `from`), is odd.
 * Only runs of `\\` matter: every backslash in the run is itself escapable, so
 * the run pairs up left to right and a leftover one escapes s[j]. */
function isEscaped(s, from, j) {
  let n = 0;
  for (let k = j - 1; k >= from && s[k] === '\\'; k--) n++;
  return (n & 1) === 1;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (!ESCAPABLE.has(what[0]) || !isEscaped(s, from, j)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, from, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

const INLINE_TEST = /[\\`*\[&<>"']/;
const MD_TEST = /[*`\\[]/;

/**
 * `s` rendered inline; `link(target)` is a link's href. Strings with no markdown
 * or HTML-special character are returned as-is; otherwise a regex jumps from one
 * special character to the next and plain runs are pushed whole. The scanning
 * regex is per-call: inline recurses, so a shared /g/ regex would lose its place.
 */
function inline(s, link) {
  if (!INLINE_TEST.test(s)) return s;
  if (!MD_TEST.test(s)) return esc(s);
  const next = /[\\`*\[&<>"']/g;
  const out = [];
  let run = 0;
  let m;
  while ((m = next.exec(s)) !== null) {
    const i = m.index;
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
      if (i > run) out.push(s.slice(run, i));
      out.push(s[i + 1]);
      run = i + 2;
      next.lastIndex = run;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        run = j + 1;
        next.lastIndex = run;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>', inline(s.slice(i + 2, j), link), '</strong>');
          run = j + 2;
          next.lastIndex = run;
        } else {
          // No closer: both stars are literal, as in the reference's i += 2.
          next.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<em>', inline(s.slice(i + 1, j), link), '</em>');
        run = j + 1;
        next.lastIndex = run;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RUN.test(target)) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<a href="', esc(link(target)), '">', inline(s.slice(i + 1, k), link), '</a>');
        run = mm + 1;
        next.lastIndex = run;
      }
      continue;
    }
    // An HTML-special character: flush the run and write the entity.
    if (i > run) out.push(s.slice(run, i));
    out.push(c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
    run = i + 1;
  }
  if (s.length > run) out.push(s.slice(run));
  return out.join('');
}

/**
 * `src` rendered in one pass (no token objects): its HTML (each block on its own
 * lines, a "\n" after the last), its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const c0 = line.length === 0 ? '' : line[0];
    if (c0 === '' || c0 === ' ' || c0 === '\t') {
      if (isBlank(line)) {
        i++;
        continue;
      }
    }
    const fence = c0 === '`' ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const body = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${esc(fence[1])}"`;
      let code = '';
      for (const l of body) code += `${esc(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const h = c0 === '#' ? headingOf(line) : null;
    if (h !== null) {
      const id = uniqSlug(slugify(h.text, slugCache), ids);
      const html = inline(h.text, link);
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === '-' || c0 === '*') && HR.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const inner = body.map(trimLine).filter((l) => l !== '');
      blocks.push(inner.length === 0
        ? '<blockquote>\n</blockquote>'
        : `<blockquote>\n<p>${inline(inner.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bm = (c0 === '-' || c0 === '*') ? BULLET.exec(line) : null;
    const om = bm === null && c0 >= '0' && c0 <= '9' ? ORDERED.exec(line) : null;
    if (bm !== null || om !== null) {
      const isOrd = om !== null;
      const marker = isOrd ? ORDERED : BULLET;
      const start = isOrd ? Number(om[1]) : 1;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrd ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// --- Templates --------------------------------------------------------------
// Dialect: {{ path }} escaped, {{{ path }}} raw, {% for x in path %},
// {% if [not] path %} / {% else %} / {% endif %}, {% include "name" %}.
// Templates are parsed once into a node tree, then compiled to a JS function
// (via new Function) so rendering is native code, not a tree walk.

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INC = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open))
      && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = T_FOR.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = T_IF.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body
        : parent.kind === 'for' ? parent.body : (parent.els ?? parent.then);
    } else if ((m = T_INC.exec(tag)) !== null) {
      body.push({ kind: 'inc', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.v, path[0])) s = s.p;
  if (s === null) return undefined;
  let v = s.v[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, number in JS digits, true/false, array joined by ", ". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or []. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Compile a parsed template to `fn(T, S, D, L, txt, esc, truthy)`: T is the map of
 * compiled templates, S the scope { v, p }, D the include depth.
 */
function compileTemplate(nodes) {
  let uid = 0;
  // Whether a node list reads `loop.*` in this scope: var/raw/if paths, and a
  // nested for's own path (evaluated in this scope). A nested for's body is
  // skipped: its `loop` is the nested loop, not this one. An include is
  // conservative: the included template may read this scope's loop.
  const usesLoop = (ns) => {
    for (const n of ns) {
      if (n.kind === 'var' || n.kind === 'raw') {
        if (n.path[0] === 'loop') return true;
      } else if (n.kind === 'if') {
        if (n.path[0] === 'loop') return true;
        if (usesLoop(n.then)) return true;
        if (n.els !== null && usesLoop(n.els)) return true;
      } else if (n.kind === 'for') {
        if (n.path[0] === 'loop') return true;
      } else if (n.kind === 'inc') return true;
    }
    return false;
  };
  const gen = (ns, S) => {
    let code = '';
    for (const n of ns) {
      if (n.kind === 'text') code += `o.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') {
        const v = `_v${uid++}`;
        code += `var ${v}=L(${S},${JSON.stringify(n.path)});o.push(esc(typeof ${v}==='string'?${v}:txt(${v})));`;
      } else if (n.kind === 'raw') {
        const v = `_v${uid++}`;
        code += `var ${v}=L(${S},${JSON.stringify(n.path)});o.push(typeof ${v}==='string'?${v}:txt(${v}));`;
      } else if (n.kind === 'if') {
        const c = n.not
          ? `!truthy(L(${S},${JSON.stringify(n.path)}))`
          : `truthy(L(${S},${JSON.stringify(n.path)}))`;
        code += `if(${c}){${gen(n.then, S)}}`;
        if (n.els !== null) code += `else{${gen(n.els, S)}}`;
      } else if (n.kind === 'for') {
        const a = `_a${uid}`;
        const k = `_i${uid}`;
        const s = `_s${uid}`;
        uid++;
        // One scope object per loop, mutated per item: rendering is
        // synchronous, so nothing retains a per-item scope.
        code += `var ${a}=L(${S},${JSON.stringify(n.path)});`
          + `if(Array.isArray(${a})){var ${s}={v:{},p:${S}};for(var ${k}=0;${k}<${a}.length;${k}++){`
          + `${s}.v[${JSON.stringify(n.name)}]=${a}[${k}];`
          + (usesLoop(n.body)
            ? `${s}.v.loop={index:${k}+1,first:${k}===0,last:${k}===${a}.length-1,length:${a}.length};`
            : '')
          + `${gen(n.body, s)}}}`;
      } else if (n.kind === 'inc') {
        const t = `_t${uid}`;
        uid++;
        code += `if(D<${INCLUDE_DEPTH}){var ${t}=T.get(${JSON.stringify(n.name)});`
          + `if(${t}!==undefined)o.push(${t}(T,${S},D+1,L,txt,esc,truthy));}`;
      }
    }
    return code;
  };
  return new Function('T', 'S', 'D', 'L', 'txt', 'esc', 'truthy',
    `var o=[];${gen(nodes, 'S')}return o.join('');`);
}

// --- build ------------------------------------------------------------------

const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : {
  title: s.data.title,
  url: s.url,
  date: s.data.date ?? '',
  date_long: s.data.date === undefined ? '' : longDate(s.data.date),
});

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCU)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Sources, in code-unit order of path; .md is a source, anything else static.
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in order; a draft is reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug; newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, named as first met walking the posts in collection
  // order, ordered by post count then slug. A page's tags link to the posts' tag
  // of the same slug, or have url "" where no post has it.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ name, slug });
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map(({ name, slug }) =>
      bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));

  // Cards, pages, and the render scope shared by every template.
  const cardCache = new Map();
  const cardOf = (s) => {
    const hit = cardCache.get(s);
    if (hit !== undefined) return hit;
    const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, card);
    return card;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    return fn(templates, { v: { site, tags: allTags, recent, ...vars }, p: null },
      0, lookup, textOf, esc, truthy);
  };

  const output = {};
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name, slug: t.slug, url: t.url, count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and unparsed template, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(byCU);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
