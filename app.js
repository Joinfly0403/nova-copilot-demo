/* ============================================================
   Nova Copilot — AI Agent overlay demo
   Vanilla JS. No build step, no network calls.
   Sections:
     01 store / persistence      06 turn orchestration
     02 dom refs / helpers       07 composer & queue
     03 markdown + highlight     08 window chrome (modes, drag, sheet)
     04 generated UI cards       09 modals, toasts, a11y, shortcuts
     05 thread rendering         10 boot
   ============================================================ */
(function () {
  'use strict';

  /* ==========================================================
     01 store / persistence
     ========================================================== */
  const STORE_KEY = 'nova.copilot.v1';
  const MAX_SESSIONS = 20;
  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 4 * 1024 * 1024;
  const MAX_INPUT = 2000;

  const defaults = {
    version: 1,
    mode: 'closed',
    geo: { w: 480, h: 800, t: null, l: null, corner: 'br' },
    sheetH: 0.66,
    theme: 'light',
    device: 'desktop',
    prefs: { context: true, hostActions: true, autoScroll: true, reduceMotion: false, speed: 1 },
    sessions: [],
    currentId: null,
    greeted: false,
  };

  function uid(prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 9);
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
  const DBGLOG = [];
  function DBG(tag, data) {
    if (location.search.indexOf('debug=1') >= 0) {
      DBGLOG.push({ t: Date.now(), tag, data });
      if (DBGLOG.length > 200) DBGLOG.shift();
    }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function debounce(fn, ms) {
    let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }
  function timeLabel(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return '今天 ' + timeLabel(ts);
    const y = new Date(now.getTime() - 864e5);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + timeLabel(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return structuredClone(defaults);
      const s = JSON.parse(raw);
      return Object.assign(structuredClone(defaults), s, {
        geo: Object.assign({}, defaults.geo, s.geo),
        prefs: Object.assign({}, defaults.prefs, s.prefs),
      });
    } catch (e) { return structuredClone(defaults); }
  }

  const hadSavedState = (function () { try { return !!localStorage.getItem(STORE_KEY); } catch (e) { return false; } })();
  const store = load();
  const save = debounce(function () {
    try {
      store.sessions = store.sessions.slice(0, MAX_SESSIONS);
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (e) { /* quota */ }
  }, 260);

  const S = {
    busy: false,
    abort: null,
    approved: null,
    messages: [],
    attachments: [],
    queue: [],
    stream: null,
    editing: null,
    modals: [],
    lastFocus: null,
    demoPrevMode: null,
    unseen: 0,
  };

  function currentSession() {
    let s = store.sessions.find(x => x.id === store.currentId);
    if (!s) {
      s = { id: uid('s'), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      store.sessions.unshift(s);
      store.currentId = s.id;
    }
    return s;
  }
  function ensureMessages() {
    const s = currentSession();
    S.messages = s.messages;
    return S.messages;
  }
  function newSession(opts) {
    const s = { id: uid('s'), title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    store.sessions.unshift(s);
    store.currentId = s.id;
    store.sessions = store.sessions.slice(0, MAX_SESSIONS);
    S.messages = s.messages;
    S.queue = [];
    S.attachments = [];
    S.busy = false;
    S.abort = null;
    S.unseen = 0;
    save();
    if (!opts || !opts.silent) { renderThread(true); renderQueue(); renderSessionList(); }
  }

  /* ==========================================================
     02 dom refs / helpers
     ========================================================== */
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const html = document.documentElement;
  const bodyEl = document.body;
  const hostEl = $('#host');
  const agentEl = $('#agent');
  const threadEl = $('#thread');
  const threadInner = $('#threadInner');
  const inputEl = $('#input');
  const sendBtn = $('#sendBtn');
  const launcherEl = $('#launcher');
  const fabEl = $('#fab');
  const composerBox = $('#composerBox');

  const D = {
    agent: agentEl, thread: threadEl, inner: threadInner, input: inputEl,
    head: $('#agentHead'), jump: $('#jumpBottom'), jumpBtn: $('#jumpBtn'),
    newCount: $('#newCount'), backdrop: $('#backdrop'), toasts: $('#toasts'),
    ctxPop: $('#ctxPop'), ctxList: $('#ctxList'), ctxStrip: $('#ctxStrip'),
    queueTray: $('#queueTray'), queueList: $('#queueList'), queueCount: $('#queueCount'),
    attachments: $('#attachments'), charCount: $('#charCount'),
    composer: $('#composer'), hint: $('#composerHint'),
    historyModal: $('#historyModal'), settingsModal: $('#settingsModal'),
    sessionList: $('#sessionList'), demoPanel: $('#demoPanel'),
  };

  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function motionReduced() { return REDUCED || store.prefs.reduceMotion; }

  /* ==========================================================
     03 markdown + syntax highlighting
     ========================================================== */
  function inline(text) {
    let t = esc(text);
    t = t.replace(/`([^`\n]+)`/g, (m, code) => '<code>' + code + '</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const safe = /^(https?:|#|\/)/.test(url) ? url : '#';
      return '<a href="' + safe + '" target="_blank" rel="noreferrer noopener">' + label + '</a>';
    });
    return t;
  }

  const LANG_HINT = {
    bash: 'bash', sh: 'bash', shell: 'bash', sql: 'sql', json: 'json',
    js: 'javascript', javascript: 'javascript', ts: 'typescript', typescript: 'typescript',
    diff: 'diff', yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css', py: 'python', python: 'python',
  };

  function highlight(code, lang) {
    let t = esc(code);
    const l = String(lang || '').toLowerCase();
    if (l === 'diff') {
      return t.split('\n').map(line => {
        if (/^\+/.test(line)) return '<span class="diff-add">' + line + '</span>';
        if (/^-/.test(line)) return '<span class="diff-del">' + line + '</span>';
        return line;
      }).join('\n');
    }
    // strings, comments, numbers — order matters; tokens are preserved via placeholders
    const tokens = [];
    const keep = (cls, text) => {
      tokens.push('<span class="' + cls + '">' + text + '</span>');
      return '\u0000' + (tokens.length - 1) + '\u0000';
    };
    t = t.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|&#39;(?:[^&]|&(?!#39;))*?&#39;)/g, m => keep('tok-str', m));
    if (/^(js|javascript|ts|typescript|json|sql|py|python)$/.test(l)) {
      t = t.replace(/(\/\/[^\n]*|--[^\n]*|#[^\n]*)/g, m => keep('tok-com', m));
      t = t.replace(/\b(\d+(?:\.\d+)?)\b/g, m => keep('tok-num', m));
      t = t.replace(/\b(const|let|var|function|return|if|else|for|await|async|import|from|export|class|new|true|false|null|SELECT|FROM|WHERE|GROUP BY|ORDER BY|LIMIT|def)\b/g, m => keep('tok-key', m));
    }
    return t.replace(/\u0000(\d+)\u0000/g, (m, i) => tokens[+i]);
  }

  function codeBlock(code, lang, file) {
    const l = LANG_HINT[String(lang || '').toLowerCase()] || lang || 'text';
    return '<div class="code-block"><div class="code-head">' +
      '<span class="code-lang">' + esc(l) + '</span>' +
      (file ? '<span class="code-file">' + esc(file) + '</span>' : '') +
      '<span class="code-actions">' +
        '<button data-copy-code title="复制代码" aria-label="复制代码"><svg viewBox="0 0 24 24" width="12" height="12"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>' +
      '</span></div><pre><code>' + highlight(code, l) + '</code></pre></div>';
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
  }
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function md(src) {
    const text = String(src == null ? '' : src).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const blocks = [];
    const stash = (h) => { blocks.push(h); return '\u0000B' + (blocks.length - 1) + '\u0000'; };

    // fenced code
    let work = text.replace(/```([\w+-]*)[ \t]*([^\n]*)\n([\s\S]*?)(?:```|$)/g, (m, lang, file, code) => {
      return stash(codeBlock(code.replace(/\n$/, ''), lang, file.trim()));
    });

    const lines = work.split('\n');
    const out = [];
    let i = 0;
    const inlineBlock = (s) => s.replace(/\u0000B(\d+)\u0000/g, (m, k) => blocks[+k]);

    while (i < lines.length) {
      let line = lines[i];

      if (!line.trim()) { i++; continue; }

      if (/^\u0000B\d+\u0000$/.test(line.trim())) { out.push(inlineBlock(line.trim())); i++; continue; }

      // heading
      let h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const lv = h[1].length;
        out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>');
        i++; continue;
      }

      // hr
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr>'); i++; continue; }

      // table
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i])); i++;
        }
        let t = '<div class="tbl-wrap"><table><thead><tr>' +
          head.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
        rows.forEach(r => {
          t += '<tr>' + head.map((_, k) => '<td>' + inline(r[k] || '') + '</td>').join('') + '</tr>';
        });
        t += '</tbody></table></div>';
        out.push(t); continue;
      }

      // blockquote
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push('<blockquote><p>' + inline(buf.join(' ')) + '</p></blockquote>');
        continue;
      }

      // ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++;
        }
        out.push('<ol>' + items.map(x => '<li>' + inline(x) + '</li>').join('') + '</ol>');
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++;
        }
        out.push('<ul>' + items.map(x => '<li>' + inline(x) + '</li>').join('') + '</ul>');
        continue;
      }

      // paragraph
      const buf = [];
      while (i < lines.length && lines[i].trim() &&
             !/^(#{1,4})\s|^>\s?|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^\u0000B\d+\u0000$/.test(lines[i]) &&
             !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) {
        buf.push(lines[i]); i++;
      }
      out.push('<p>' + inline(buf.join(' ')) + '</p>');
    }
    return out.join('').replace(/\u0000B(\d+)\u0000/g, (m, k) => blocks[+k]);
  }

  /* ==========================================================
     04 generated UI cards
     ========================================================== */
  let svgSeq = 0;
  const C = {
    ink4: '#7f8aa3',
    brand: '#7c8bff',
    brand2: '#a78bfa',
    mint: '#34d399',
    cyan: '#22d3ee',
    rose: '#fb7185',
    line: 'rgba(127,138,163,.22)'
  };

  function areaPath(vals, w, h, pad) {
    const max = Math.max.apply(null, vals) * 1.12;
    const min = 0;
    const x = i => pad + (i * (w - pad * 2) / (vals.length - 1 || 1));
    const y = v => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
    const line = vals.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    return {
      line,
      area: line + ' L' + x(vals.length - 1).toFixed(1) + ' ' + (h - pad) + ' L' + x(0).toFixed(1) + ' ' + (h - pad) + ' Z',
      x, y, max
    };
  }

  function renderChart(block) {
    const w = 540, h = 250, padL = 10, padB = 26;
    const labels = block.labels || [];
    const series = block.series || [];
    const id = 'g' + (++svgSeq);
    let grid = '';
    for (let k = 0; k < 4; k++) {
      const y = 8 + k * ((h - padB - 8) / 3);
      grid += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (w - 4) + '" y2="' + y.toFixed(1) + '" stroke="' + C.line + '"/>';
    }
    let paths = '';
    let legend = '';
    series.forEach((s, si) => {
      const ap = areaPath(s.values, w, h - padB, 10);
      const color = s.color || [C.mint, C.cyan, C.brand2][si % 3];
      if (s.area) {
        paths += '<path d="' + ap.area + '" fill="url(#' + id + si + ')" opacity=".85"/>';
      }
      paths += '<path d="' + ap.line + '" fill="none" stroke="' + color + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"' +
        (s.dashed ? ' stroke-dasharray="6 5"' : '') + '>' +
        '<animate attributeName="stroke-dasharray" from="0 1200" to="1200 0" dur=".9s" fill="freeze"/></path>';
      const last = s.values.length - 1;
      paths += '<circle cx="' + ap.x(last).toFixed(1) + '" cy="' + ap.y(s.values[last]).toFixed(1) + '" r="3.5" fill="' + color + '" stroke="var(--panel-solid)" stroke-width="1.5"/>';
      legend += '<span><i style="background:' + color + '"></i>' + esc(s.name) + '</span>';
    });
    let defs = '';
    series.forEach((s, si) => {
      const color = s.color || [C.mint, C.cyan, C.brand2][si % 3];
      defs += '<linearGradient id="' + id + si + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + color + '" stop-opacity=".28"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient>';
    });
    // axis labels live in HTML so they stay legible while the plot stretches
    const xs = '<div class="chart-axis">' + labels.map(l => '<span>' + esc(l) + '</span>').join('') + '</div>';

    return '<div class="rich"><div class="rich-head"><b>' + esc(block.title || '趋势') + '</b>' +
      (block.note ? '<span>' + esc(block.note) + '</span>' : '') +
      '<span class="rich-tag">生成式 UI</span></div>' +
      '<div class="chart-card"><div class="chart-legend">' + legend + '</div>' +
      '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" role="img" aria-label="' + esc(block.title || '图表') + '">' +
      '<defs>' + defs + '</defs>' + grid + paths + '</svg>' + xs + '</div></div>';
  }

  function renderMetrics(block) {
    const items = block.items || [];
    return '<div class="rich"><div class="rich-head"><b>' + esc(block.title || '关键指标') + '</b>' +
      '<span class="rich-tag">生成式 UI</span></div><div class="metric-grid">' +
      items.map((m, i) => {
        const dir = m.delta == null ? 'flat' : (m.delta > 0 ? (m.invert ? 'down' : 'up') : (m.invert ? 'up' : 'down'));
        const arrow = m.delta == null ? '•' : (m.delta > 0 ? '▲' : '▼');
        return '<div class="metric" style="animation-delay:' + (i * 55) + 'ms">' +
          '<div class="metric-k">' + esc(m.label) + '</div>' +
          '<div class="metric-v">' + esc(m.value) + (m.unit ? '<small>' + esc(m.unit) + '</small>' : '') + '</div>' +
          '<div class="metric-d ' + dir + '">' + arrow + ' ' + esc(m.deltaText || '') + ' <em>' + esc(m.hint || '') + '</em></div>' +
          (m.progress != null ? '<div class="metric-bar"><i style="width:' + clamp(m.progress, 2, 100) + '%"></i></div>' : '') +
          '</div>';
      }).join('') + '</div></div>';
  }

  function renderDiff(block) {
    const lines = (block.lines || []).map(l => {
      let cls = 'ctx', n = '';
      if (l.startsWith('+')) { cls = 'add'; n = '+'; }
      else if (l.startsWith('-')) { cls = 'del'; n = '−'; }
      return '<div class="diff-line ' + cls + '"><span class="ln">' + n + '</span>' + esc(l) + '</div>';
    }).join('');
    return '<div class="rich"><div class="rich-head"><b>' + esc(block.title || 'Diff') + '</b><span class="rich-tag">生成式 UI</span></div>' +
      '<div class="diff-card"><div class="diff-head">' + esc(block.file || 'changes.diff') +
      '<span class="diff-stat"><span class="add">+' + (block.add || 0) + '</span><span class="del">−' + (block.del || 0) + '</span></span></div>' +
      '<div class="diff-body">' + lines + '</div></div></div>';
  }

  function renderTimeline(block) {
    return '<div class="rich"><div class="rich-head"><b>' + esc(block.title || '时间线') + '</b><span class="rich-tag">生成式 UI</span></div>' +
      '<div class="timeline">' + (block.items || []).map(it =>
        '<div class="tl-item ' + (it.state || '') + '"><div class="tl-time">' + esc(it.time || '') + '</div>' +
        '<div class="tl-title">' + esc(it.title) + '</div>' +
        (it.desc ? '<div class="tl-desc">' + esc(it.desc) + '</div>' : '') + '</div>'
      ).join('') + '</div></div>';
  }

  function renderTable(block) {
    const rows = block.rows || [];
    const max = Math.max.apply(null, rows.map(r => Number(r[block.barCol]) || 0).concat([1]));
    return '<div class="rich"><div class="rich-head"><b>' + esc(block.title || '明细') + '</b><span class="rich-tag">生成式 UI</span></div>' +
      '<table class="inline-table"><thead><tr>' + (block.head || []).map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map((c, ci) => {
        if (ci === block.barCol) {
          const v = Number(c) || 0;
          return '<td><div class="bar-cell"><i style="width:' + (v / max * 54).toFixed(0) + 'px"></i><span>' + esc(c) + '</span></div></td>';
        }
        return '<td class="' + (typeof c === 'number' ? 'num' : '') + '">' + esc(c) + '</td>';
      }).join('') + '</tr>').join('') + '</tbody></table></div>';
  }

  function renderRich(b) {
    try {
      switch (b.kind) {
        case 'chart': return renderChart(b);
        case 'metrics': return renderMetrics(b);
        case 'diff': return renderDiff(b);
        case 'timeline': return renderTimeline(b);
        case 'table': return renderTable(b);
        default: return '';
      }
    } catch (err) {
      console.error('rich render failed:', b.kind, err);
      return '<div class="rich"><div class="tool failed">生成式 UI 渲染失败：' + esc(err.message) + '</div></div>';
    }
  }

  function renderApproval(b) {
    const decided = b.decision;
    const state = decided ? ' decided' : '';
    let badgeCls = '', badgeTxt = '等待审批';
    if (decided === 'approved') { badgeCls = ' ok'; badgeTxt = '已批准'; }
    if (decided === 'rejected') { badgeCls = ' no'; badgeTxt = '已拒绝'; }

    let fields = '';
    if (!decided && b.form) {
      fields = '<div class="form-grid">' + b.form.map(f => {
        if (f.type === 'select') {
          return '<div class="field"><label>' + esc(f.label) + '</label><select data-field="' + esc(f.name) + '">' +
            f.options.map(o => '<option' + (o === f.value ? ' selected' : '') + '>' + esc(o) + '</option>').join('') + '</select></div>';
        }
        if (f.type === 'check') {
          return '<label class="check-row"><input type="checkbox" data-field="' + esc(f.name) + '"' + (f.value ? ' checked' : '') + '> ' + esc(f.label) + '</label>';
        }
        return '<div class="field"><label>' + esc(f.label) + '</label><input data-field="' + esc(f.name) + '" value="' + esc(f.value || '') + '" placeholder="' + esc(f.placeholder || '') + '"></div>';
      }).join('') + '</div>';
    }

    return '<div class="approval' + state + '" data-approval="' + esc(b.id) + '">' +
      '<div class="approval-head"><span class="approval-ic">' + (b.icon || '⚑') + '</span><b>' + esc(b.kindLabel || '需要你的确认') + '</b>' +
      '<span class="approval-badge' + badgeCls + '">' + badgeTxt + '</span></div>' +
      '<div class="approval-body">' +
        '<p class="approval-title">' + esc(b.title) + '</p>' +
        (b.desc ? '<p class="approval-desc">' + esc(b.desc) + '</p>' : '') +
        '<div class="kv">' + (b.rows || []).map(r => '<div class="kv-row"><b>' + esc(r[0]) + '</b><span>' + esc(r[1]) + '</span></div>').join('') + '</div>' +
        fields +
      '</div>' +
      (decided
        ? '<div class="approval-actions decided-row"><span class="decision-ic ' + (decided === 'approved' ? 'ok' : 'no') + '">' +
            (decided === 'approved' ? '✓' : '✕') + '</span><span class="decision-text">' +
            esc(b.note || '已记录决策，Agent 将继续执行。') + '</span></div>'
        : '<div class="approval-actions">' +
            '<button class="btn primary" data-approve="' + esc(b.id) + '">' + esc(b.okText || '批准并继续') + '</button>' +
            '<button class="btn ghosty" data-approve-edit="' + esc(b.id) + '">修改参数</button>' +
            '<button class="btn danger" data-reject="' + esc(b.id) + '">拒绝</button>' +
            '<span class="note">z-index 低于模态框 · 不会遮挡确认对话框</span>' +
          '</div>') +
      '</div>';
  }

  /* ==========================================================
     05 thread rendering
     ========================================================== */
  function scrollNearBottom(px) {
    const t = D.thread;
    return t.scrollHeight - t.scrollTop - t.clientHeight < (px || 72);
  }
  function scrollBottom(smooth) {
    const t = D.thread;
    const behavior = smooth && !motionReduced() ? 'smooth' : 'auto';
    if (t.scrollTo) t.scrollTo({ top: t.scrollHeight, behavior });
    else t.scrollTop = t.scrollHeight;
    S.unseen = 0;
    updateJump();
  }
  function updateJump() {
    const near = scrollNearBottom(40);
    D.jump.hidden = near || !S.messages.length;
    D.newCount.hidden = S.unseen <= 0;
    D.newCount.textContent = S.unseen;
  }
  function maybeScroll() {
    if (store.prefs.autoScroll !== false && scrollNearBottom(120)) scrollBottom(false);
    else { if (S.busy) { S.unseen++; updateJump(); } }
  }

  function userBubble(m) {
    return (m.text ? '<div class="bubble">' + md(m.text) + '</div>' : '') +
      (m.files && m.files.length
        ? '<div class="msg-files">' + m.files.map(f => '<span class="msg-file">▤ ' + esc(f.name) + '</span>').join('') + '</div>'
        : '');
  }

  function msgActions(m) {
    if (m.role === 'user') {
      return '<div class="msg-actions">' +
        '<button data-a="copy" data-id="' + m.id + '" title="复制">' + ICON.copy + '复制</button>' +
        '<button data-a="edit" data-id="' + m.id + '" title="编辑后重发">' + ICON.edit + '编辑</button>' +
        '<button data-a="del" data-id="' + m.id + '" title="删除这条">' + ICON.trash + '</button>' +
        '</div>';
    }
    return '<div class="msg-actions">' +
      '<button data-a="copy" data-id="' + m.id + '">' + ICON.copy + '复制</button>' +
      '<button data-a="regen" data-id="' + m.id + '">' + ICON.regen + '重新生成</button>' +
      '<span class="sep"></span>' +
      '<button data-a="up" data-id="' + m.id + '" class="' + (m.feedback === 'up' ? 'on' : '') + '" aria-label="有帮助">' + ICON.up + '</button>' +
      '<button data-a="down" data-id="' + m.id + '" class="' + (m.feedback === 'down' ? 'on' : '') + '" aria-label="没帮助">' + ICON.down + '</button>' +
      '<button data-a="read" data-id="' + m.id + '" aria-label="朗读">' + ICON.speaker + '</button>' +
      '</div>';
  }

  const ICON = {
    copy: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15 5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m13.5 6.5 4 4" stroke="currentColor" stroke-width="1.7"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2m-8 0 1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    regen: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M7 20V9l5-5 1 1v5h5.5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M17 4v11l-5 5-1-1v-5H5.5a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.7 4H17Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M5 10v4h3l4 3V7L8 10H5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7 7 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  };

  function avatarFor(role) {
    if (role === 'user') return '<span class="msg-avatar" aria-hidden="true">林</span>';
    return '<span class="msg-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M12 3.2 13.9 9l5.8 1.9-5.8 1.9L12 18.6l-1.9-5.8L4.3 10.9 10.1 9 12 3.2Z" fill="currentColor"/></svg></span>';
  }

  function statusChip(m) {
    if (m.role === 'assistant' && m.status === 'stopped') return '<span class="msg-status stopped">已中断</span>';
    if (m.role === 'user' && m.files && m.files.length) return '<span class="msg-status">' + m.files.length + ' 个附件</span>';
    return '';
  }

  function messageBody(m) {
    if (m.role === 'user') return userBubble(m);
    const blocks = m.blocks || [];
    const caret = m.status === 'streaming' ? '<span class="stream-caret"></span>' : '';
    let h = '';
    for (const b of blocks) {
      if (b.type === 'approval') h += renderApproval(b);
      else if (b.type === 'rich') h += renderRich(b);
      else if (b.type === 'textSeg') {
        if (!b.text && !b.live) continue; // placeholder segment awaiting text
        h += '<div class="md" data-md="1"' + (b.live && !b.done ? ' data-layer="live" data-stream-slot="1"' : '') + '>' +
          md(b.text || '') + (b.live && !b.done ? caret : '') + '</div>';
      }
    }
    if (m.status === 'streaming' && !blocks.length) {
      h += '<div class="md" data-md="1" data-layer="live">' + caret + '</div>';
    }
    if (m.followups && m.followups.length && m.status !== 'streaming') {
      h += '<div class="followups">' + m.followups.map(f => '<button class="followup" data-suggest="' + esc(f) + '">' + esc(f) + '</button>').join('') + '</div>';
    }
    return h;
  }

  function buildMessageEl(m) {
    const el = document.createElement('article');
    el.className = 'msg ' + m.role;
    el.dataset.msgId = m.id;
    if (m.share) el.dataset.share = '1';
    el.innerHTML =
      avatarFor(m.role) +
      '<div class="msg-main">' +
        '<div class="msg-meta"><span class="msg-name">' + (m.role === 'user' ? '你' : 'Aria') + '</span>' +
          '<span class="msg-time">' + timeLabel(m.ts) + '</span>' + statusChip(m) + '</div>' +
        '<div class="msg-body">' + messageBody(m) + '</div>' +
        (m.role === 'assistant' && !m.share ? msgActions(m) : '') +
      '</div>';
    return el;
  }

  function renderThread(force) {
    const msgs = S.messages;
    if (!msgs.length) {
      threadInner.innerHTML = emptyState();
      updateJump();
      return;
    }
    const ids = new Set(msgs.map(m => m.id));
    Array.from(threadInner.children).forEach(ch => {
      if (ch.dataset.msgId && !ids.has(ch.dataset.msgId)) ch.remove();
    });
    msgs.forEach((m, i) => {
      let el = threadInner.querySelector('[data-msg-id="' + m.id + '"]');
      if (!el) {
        el = buildMessageEl(m);
        // insert at correct position
        const next = msgs.slice(i + 1).map(x => x.id);
        let anchor = null;
        for (const nid of next) {
          const cand = threadInner.querySelector('[data-msg-id="' + nid + '"]');
          if (cand) { anchor = cand; break; }
        }
        threadInner.insertBefore(el, anchor || null);
        el.classList.add('msg-new');
        setTimeout(() => el && el.classList.remove('msg-new'), 300);
      } else {
        const body = el.querySelector('.msg-body');
        const nextHtml = messageBody(m);
        if (body && body.innerHTML !== nextHtml) body.innerHTML = nextHtml;
        const meta = el.querySelector('.msg-meta');
        if (meta) meta.innerHTML = '<span class="msg-name">' + (m.role === 'user' ? '你' : 'Aria') + '</span>' +
          '<span class="msg-time">' + timeLabel(m.ts) + '</span>' + statusChip(m);
        const acts = el.querySelector('.msg-actions');
        if (acts) acts.outerHTML = msgActions(m);
      }
    });
    updateJump();
  }

  function appendMessage(m) {
    S.messages.push(m);
    currentSession().updatedAt = Date.now();
    renderThread();
    maybeScroll();
    save();
    return m;
  }
  function findMsg(id) { return S.messages.find(m => m.id === id); }
  function findApproval(id) {
    for (const m of S.messages) {
      const b = (m.blocks || []).find(x => x.type === 'approval' && x.id === id);
      if (b) return { msg: m, block: b };
    }
    return null;
  }

  function emptyState() {
    const ctx = collectContext();
    return '<div class="empty">' +
      '<div class="empty-kicker">Nova Copilot · 上下文已注入</div>' +
      '<h2>你好，我是 <span>Aria</span>。<br>我正看着你眼前的这页数据。</h2>' +
      '<p>我不只是一个聊天框：可以读页面、调工具、画图表，也能在动手之前先问你一句。</p>' +
      '<div class="empty-ctx"><span class="empty-ctx-ic">◪</span><div><b>' + esc(ctx.title) + '</b>' +
        '<p>' + esc(ctx.kpiHint) + '</p></div><span class="pill">已注入</span></div>' +
      '<div class="starters">' +
        starter('analyze', '📉', 'mint', '归因 W36 以来的收入下滑', '查数 → 归因 → 给出可执行动作', '分析一下 W36 以来收入下滑的原因，并给出可执行动作') +
        starter('chart', '📊', 'cyan', '把近 12 周收入与激活率画出来', '生成式 UI · 内联图表', '用图表对比近 12 周的收入和激活率') +
        starter('approval', '🛡', 'amber', '生成周报并等待我审批', 'Human-in-the-loop · 审批卡片', '帮我生成一份本周增长周报并提交给团队') +
        starter('diff', '🧩', 'violet', '更新埋点定义的代码 Diff', '工具调用 · 差异对比', '给我看一下埋点口径修复的代码 diff') +
      '</div>' +
      '<div class="empty-foot">' +
        '<button class="tag-btn" data-suggest="高亮页面里异常的指标">高亮异常指标</button>' +
        '<button class="tag-btn" data-suggest="/chart 渠道转化">/chart 渠道转化</button>' +
        '<button class="tag-btn" data-suggest="如果我现在要扩量，应该先修哪一环？">扩量建议</button>' +
        '<button class="tag-btn" data-suggest="把这些结论导出成周报">导出周报</button>' +
      '</div></div>';
  }
  function starter(id, ic, tone, title, sub, q) {
    return '<button class="starter" data-starter="' + id + '" data-q="' + esc(q) + '">' +
      '<span class="starter-ic ' + tone + '">' + ic + '</span>' +
      '<span><b>' + esc(title) + '</b><small>' + esc(sub) + '</small></span>' +
      '<span class="arr" aria-hidden="true">→</span></button>';
  }

  /* ==========================================================
     Context injection
     ========================================================== */
  function collectContext() {
    const title = '增长驾驶舱';
    const selected = String(window.getSelection ? window.getSelection().toString() : '').trim();
    const kpis = $$('.kpi').map(k => {
      const label = (k.querySelector('.kpi-top span') || {}).textContent || '';
      const value = (k.querySelector('.kpi-value') || {}).textContent || '';
      return label.trim() + ' ' + value.trim();
    }).filter(Boolean);
    const alert = ($('.callout b') || {}).textContent || '';
    return {
      url: location.href.split('?')[0].split('#')[0],
      title,
      route: '#/analytics/overview',
      user: '林知远 · 增长负责人 (Growth Lead)',
      org: 'NovaMetrics · APAC',
      viewport: window.innerWidth + '×' + window.innerHeight,
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      selected: selected ? selected.slice(0, 120) : '',
      kpis,
      kpiHint: kpis.slice(0, 3).join(' · ') + (kpis.length > 3 ? ' 等 ' + kpis.length + ' 项' : ''),
      focus: alert ? alert.trim() : 'W36 起收入连续 3 周下滑',
    };
  }
  function renderContextList() {
    if (!store.prefs.context) {
      D.ctxList.innerHTML = '<li><span class="ctx-key">状态</span><span class="ctx-val plain">上下文注入已关闭</span></li>';
      return;
    }
    const c = collectContext();
    const rows = [
      ['页面', c.title + ' (' + c.route + ')'],
      ['URL', c.url],
      ['身份', c.user],
      ['视口', c.viewport + ' · ' + c.org],
      ['指标', c.kpiHint],
      ['焦点', c.focus],
      ['选中文本', c.selected || '（无）'],
    ];
    D.ctxList.innerHTML = rows.map(r => '<li><span class="ctx-key">' + esc(r[0]) + '</span><span class="ctx-val">' + esc(r[1]) + '</span></li>').join('');
    $('#ctxScope').textContent = c.selected ? '选中：「' + c.selected.slice(0, 18) + '」' : '选中：KPI 卡片 ×4';
    $('#ctxCount').textContent = String(store.prefs.context ? 7 : 0);
  }
  function contextPayload() {
    if (!store.prefs.context) return null;
    const c = collectContext();
    return '<details class="ctx-inject"><summary>已注入页面上下文 · ' + c.kpis.length + ' 项指标</summary><pre>' +
      esc([c.title + ' (' + c.route + ')', c.url, c.user, 'viewport ' + c.viewport, c.kpiHint, 'focus: ' + c.focus].join('\n')) +
      '</pre></details>';
  }

  function hostFlash(selector) {
    if (!store.prefs.hostActions) return false;
    const el = $(selector);
    if (!el) return false;
    el.scrollIntoView({ behavior: motionReduced() ? 'auto' : 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2600);
    return true;
  }

  /* ==========================================================
     06 turn orchestration (mock agent)
     ========================================================== */
  const TOOL_META = {
    search_docs: { label: '检索知识库', ic: '⌕', args: q => q },
    query_warehouse: { label: '查询数仓', ic: '⌗', args: q => q },
    run_sql: { label: '执行 SQL', ic: '⌗', args: q => q },
    render_chart: { label: '生成图表', ic: '◫', args: q => q },
    read_file: { label: '读取文件', ic: '▤', args: q => q },
    apply_edit: { label: '应用改动', ic: '✎', args: q => q },
    send_message: { label: '发送消息', ic: '✉', args: q => q },
    update_crm: { label: '写入 CRM', ic: '⛁', args: q => q },
  };

  function toolResult(name, ok) {
    if (!ok) return 'Error 429 · rate limited, retry with backoff';
    if (name === 'query_warehouse' || name === 'run_sql') {
      return 'rows: 12 · elapsed 184ms\nweek | revenue | activation\nW33 | 512.4 | 31.8\nW34 | 498.1 | 32.4\nW35 | 486.7 | 33.1\nW36 | 471.2 | 33.6\nW37 | 455.9 | 34.0\nW38 | 441.3 | 34.7';
    }
    if (name === 'search_docs') return '3 hits\n- 续费 SOP v2.3（企业客户）\n- 华东区投放复盘 2026-Q2\n- 埋点口径变更记录 #418';
    if (name === 'render_chart') return 'chart(area) · 2 series · 560×210';
    if (name === 'read_file') return 'anonymized 42 lines · events.ts';
    if (name === 'apply_edit') return 'patched events.ts · 1 hunk · tests queued';
    return 'ok';
  }

  async function animateToolCall(host, name, args, opts) {    opts = opts || {};
    const meta = TOOL_META[name] || { label: name, ic: '⚙', args: () => '' };
    const el = document.createElement('div');
    el.className = 'tool running';
    el.dataset.open = 'false';
    const t0 = performance.now();
    el.innerHTML =
      '<button class="tool-head" data-tool-toggle aria-expanded="false">' +
        '<span class="tool-ic">' + meta.ic + '</span>' +
        '<span class="tool-title">' + meta.label + '</span>' +
        '<span class="tool-args">' + esc(args) + '</span>' +
        '<span class="tool-right"><span class="tool-dur">运行中</span>' +
        '<span class="tool-status running">running</span>' +
        '<svg class="tool-caret" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></span>' +
      '</button>' +
      '<div class="tool-body" hidden>' +
        '<div class="tool-line"><b>tool</b><span>' + name + '</span></div>' +
        '<div class="tool-line"><b>args</b><span>' + esc(args) + '</span></div>' +
        '<div class="tool-line"><b>scope</b><span>' + esc(opts.scope || 'page-context · read-only') + '</span></div>' +
        '<div class="tool-result">执行中…</div>' +
      '</div>';
    host.appendChild(el);
    host.dataset.count = String(Number(host.dataset.count || 0) + 1);
    maybeScroll();
    let cancelled = false;
    if (S.abort) {
      const prev = S.abort.signal;
      prev.addEventListener('abort', () => { cancelled = true; }, { once: true });
    }
    const dur = (opts.duration || 620) * store.prefs.speed;
    await sleep(dur);

    const ok = opts.fail !== true && !cancelled;
    const elapsed = Math.round(performance.now() - t0);
    el.className = 'tool ' + (ok ? 'ok' : 'failed');
    const durEl = el.querySelector('.tool-dur');
    if (durEl) durEl.textContent = elapsed + 'ms';
    const st = el.querySelector('.tool-status');
    if (st) { st.className = 'tool-status ' + (ok ? 'ok' : 'failed'); st.textContent = ok ? 'success' : 'error'; }
    const res = el.querySelector('.tool-result');
    if (res) res.textContent = toolResult(name, ok);
    maybeScroll();
    return ok;
  }



  function streamText(msg, text, opts) {
    opts = opts || {};
    const seg = opts.seg || null;
    if (seg) seg.live = true;
    return new Promise(resolve => {
      const ctrl = { stopped: false };
      S.stream = ctrl;
      const speed = store.prefs.speed;
      const apply = (n) => {
        if (seg) seg.text = text.slice(0, n);
        else msg.text = text.slice(0, n);
      };
      let i = 0;
      if (motionReduced() || speed < .6) {
        apply(text.length);
        msg.status = 'streaming';
        renderThread();
        maybeScroll();
        setTimeout(() => {
          if (seg) { seg.live = false; seg.done = true; }
          msg.status = 'done';
          renderThread();
          resolve();
        }, 120);
        return;
      }
      let last = performance.now();
      function frame(now) {
        if (ctrl.stopped) {
          msg.status = 'stopped';
          if (seg) { seg.live = false; seg.done = true; }
          renderThread();
          save();
          return resolve();
        }
        const dt = Math.min(80, now - last);
        last = now;
        const chars = Math.max(1, Math.round((dt / 1000) * 62 * speed));
        i = Math.min(text.length, i + chars);
        apply(i);
        msg.status = 'streaming';
        renderThread();
        if (scrollNearBottom(140) && store.prefs.autoScroll !== false) scrollBottom(false);
        if (i < text.length) requestAnimationFrame(frame);
        else {
          if (seg) { seg.live = false; seg.done = true; }
          msg.status = 'done';
          S.stream = null;
          renderThread();
          save();
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  function ensureAssistant() {
    const m = {
      id: uid('m'), role: 'assistant', text: '', blocks: [], status: 'streaming',
      ts: Date.now(), followups: [], share: false,
    };
    appendMessage(m);
    return m;
  }

  function updateSub(text) {
    const el = $('#agentDesc');
    if (el) el.innerHTML = text;
  }

  function approvalId() { return uid('ap'); }

  /* ---------- response plans ---------- */
  function plan(q) {
    const s = q.toLowerCase();
    if (/diff|代码|埋点|改一下/.test(q)) return planDiff(q);
    if (/审批|周报|提交|发布|发送|邮件|deploy|上线/.test(q)) return planApproval(q);
    if (/图表|chart|趋势|画|可视化/.test(q)) return planChart(q);
    if (/表单|录入|配置|export|导出/.test(q)) return planForm(q);
    if (/扩量|建议|下一步|怎么办/.test(q)) return planAdvice(q);
    return planAnalyze(q);
  }

  function planAnalyze(q) {
    return {
      title: '收入异动归因',
      thinking: ['读取页面上下文：增长驾驶舱 · 4 项 KPI', '选择归因路径：收入结构 → 渠道 → 客户分层', '校验口径：企业版 ARR 含递延'],
      tools: [
        { name: 'query_warehouse', args: 'revenue_monthly by segment, region', duration: 720, scope: 'warehouse: growth_marts · read-only' },
        { name: 'run_sql', args: 'cohort_churn WHERE plan="enterprise" GROUP BY delay', duration: 640 },
        { name: 'search_docs', args: '续费 SOP 变更 / 华东区投放复盘', duration: 480 },
      ],
      metricBlock: {
        type: 'rich', kind: 'metrics', title: '归因结论 · 贡献拆解', items: [
          { label: '企业版续费延迟', value: '−5.1', unit: '%', delta: -5.1, deltaText: '−¥246K', hint: '主因', progress: 61 },
          { label: '华东区线索质量', value: '−2.2', unit: '%', delta: -2.2, deltaText: '−¥106K', hint: '次因', progress: 26 },
          { label: '自然搜索增长', value: '+1.6', unit: '%', delta: 1.6, deltaText: '+¥72K', hint: '对冲', progress: 18 },
        ]
      },
      chartBlock: {
        type: 'rich', kind: 'chart', title: '近 12 周收入 vs 激活率', note: '收入（万元）· 激活率（%）',
        labels: ['W27', 'W28', 'W29', 'W30', 'W31', 'W32', 'W33', 'W34', 'W35', 'W36', 'W37', 'W38'],
        series: [
          { name: '收入', values: [528, 521, 516, 509, 512, 501, 512.4, 498.1, 486.7, 471.2, 455.9, 441.3], color: '#34d399', area: true },
          { name: '激活率', values: [29.1, 29.8, 30.2, 30.9, 31.2, 31.5, 31.8, 32.4, 33.1, 33.6, 34.0, 34.7], color: '#22d3ee', dashed: true },
        ]
      },
      text: [
        '## 先给结论',
        'W36 以来的收入下滑**不是整体性衰退**，而是被两个可以定位的问题放大了：',
        '1. **企业版续费延迟**：12 家客户的续费话术仍停留在 v2.1，续费提醒没有触达，贡献了约 **61%** 的缺口。',
        '2. **华东区投放质量**：CPA 上升 38%，但激活率反而下降，说明买到了低意向人群，贡献约 **26%**。',
        '同期自然搜索激活率 +3.1pt，**部分对冲**了下降，说明产品本身的激活路径没有坏。',
        '> 关键判断：这是「运营触达 + 投放质量」问题，不是产品问题。先修触达，再谈扩量。',
        '### 建议动作（按 ROI 排序）',
        '| 优先级 | 动作 | 预期影响 | 负责人 |',
        '| --- | --- | --- | --- |',
        '| P0 | 12 家续费客户 48h 内人工触达 | 挽回 ¥180K ARR | 客户成功 |',
        '| P0 | 暂停华东区 2 个低效投放计划 | CPA 降 22% | 增长投放 |',
        '| P1 | 续费话术升级到 v2.3 并加自动化提醒 | 续费提前期 −6 天 | 运营 |',
        '| P2 | 补齐移动端 3 个埋点事件 | 漏斗口径可信 | 数据 |',
        '需要我把这 12 家客户名单拉出来，并生成一份可以直接发给客户成功的清单吗？'
      ].join('\n'),
      actions: [
        { label: '高亮页面异常指标', host: '#kpi-revenue' },
        { label: '生成客户名单', prompt: '把这 12 家续费延迟的企业客户名单拉出来' },
      ],
      followups: ['把这 12 家客户名单拉出来', '做一个续费挽回的 7 天计划', '如果先扩量会怎样？', '导出归因结论'],
    };
  }

  function planChart(q) {
    const aboutChannel = /渠道|channel/.test(q);
    return {
      title: '生成图表',
      thinking: ['识别意图：可视化对比', '选择图表类型：面积图 + 折线', '从页面上下文取时间范围：近 12 周'],
      tools: [
        { name: 'query_warehouse', args: aboutChannel ? 'channel_activation weekly' : 'revenue_activation weekly', duration: 560 },
        { name: 'render_chart', args: 'area + dashed line · 560×210', duration: 380 },
      ],
      text: '我按页面当前的时间范围（近 12 周）取数，并直接把图渲染在对话流里，你不需要跳转到报表页。',
      chartBlock: {
        type: 'rich', kind: 'chart', title: aboutChannel ? '渠道激活率对比' : '收入 vs 激活率', note: '数据源：growth_marts · 5 分钟前',
        labels: ['W33', 'W34', 'W35', 'W36', 'W37', 'W38'],
        series: aboutChannel ? [
          { name: '自然搜索', values: [38.1, 38.6, 39.2, 40.1, 40.8, 41.2], color: '#34d399', area: true },
          { name: '付费投放', values: [35.4, 34.1, 32.8, 31.2, 30.0, 28.9], color: '#fb7185', dashed: true },
          { name: '伙伴推荐', values: [49.2, 50.1, 50.8, 51.4, 52.1, 52.6], color: '#22d3ee', dashed: true },
        ] : [
          { name: '收入', values: [512.4, 498.1, 486.7, 471.2, 455.9, 441.3], color: '#34d399', area: true },
          { name: '激活率', values: [31.8, 32.4, 33.1, 33.6, 34.0, 34.7], color: '#22d3ee', dashed: true },
        ]
      },
      text2: aboutChannel
        ? '付费投放的激活率连续 4 周下滑，而自然搜索与伙伴推荐在上升——差距正在拉大，建议把预算从「买量」迁到「伙伴推荐」。'
        : '收入与激活率出现明显**背离**：激活率持续上升而收入下降，说明问题在变现端（续费/客单），不在获客端。',
      followups: ['把图导出为图片', '只看企业版客户', '加上 churn 曲线'],
      actions: [{ label: '回到收入面板', host: '#kpi-revenue' }],
    };
  }

  function planDiff(q) {
    return {
      title: '修复埋点口径',
      thinking: ['定位文件：src/analytics/events.ts', '对比 v3.1 与 v3.2 口径', '生成最小改动'],
      tools: [
        { name: 'read_file', args: 'src/analytics/events.ts · 42 lines', duration: 460 },
        { name: 'apply_edit', args: 'patch 1 hunk · dry-run', duration: 620, scope: 'repo: nova-web · branch feat/tracking' },
      ],
      text: '我找到口径问题了：`checkout_started` 在移动端缺少 `plan` 属性，导致漏斗在「支付页」断层。下面是**最小改动**，只补属性，不改事件名。',
      diffBlock: {
        type: 'rich', kind: 'diff', title: '代码改动 · dry-run', file: 'src/analytics/events.ts', add: 5, del: 2,
        lines: [
          '@@ -18,7 +18,10 @@ export function trackCheckout(payload: CheckoutPayload) {',
          '   const base = {',
          '     event: \'checkout_started\',',
          '-    ...payload,',
          '-    source: \'web\'',
          '+    ...payload,',
          '+    source: payload.source ?? \'web\',',
          '+    plan: payload.plan ?? getPlanFromSession(),',
          '+    experiment: getExperiment(\'checkout-v3\'),',
          '   };',
          '+  // TODO(tracking): drop after v3.2 backfill (2026-10-15)',
          '   return send(base);',
        ]
      },
      text2: '改动已通过类型检查与 3 个单测。要我把这个 patch 提交到 `feat/tracking` 并开一个 PR 吗？这属于写操作，我会先请你确认。',
      actions: [{ label: '提交改动（需审批）', prompt: '帮我把埋点修复提交并创建一个 PR' }],
      followups: ['补一个单元测试', '这会影响历史数据吗？', '生成 PR 描述'],
    };
  }

  function planApproval(q) {
    const ap = approvalId();
    return {
      title: '周报审批',
      thinking: ['汇总本周 4 项 KPI 与 3 条告警', '按团队模板生成周报草稿', '检测到外发动作 → 进入审批'],
      tools: [
        { name: 'search_docs', args: '周报模板 v4 / 上周同期', duration: 480 },
        { name: 'query_warehouse', args: 'weekly_summary 2026-W38', duration: 520 },
        { name: 'send_message', args: 'dry-run · #growth-weekly', duration: 500, scope: 'slack: #growth-weekly · 需要审批' },
      ],
      beforeText: '我把本周数据汇总好了，准备发到 **#growth-weekly**。这是一次**对外可见**的操作，先请你确认内容和收件范围。',
      approval: {
        type: 'approval', id: ap, icon: '✉', kindLabel: 'Human-in-the-loop · 外发审批',
        title: '发布《增长周报 · 2026 W38》到 #growth-weekly',
        desc: '包含 4 项 KPI、3 条告警与下周计划；发布后 9 位成员可见，且会归档到「团队报表」。',
        rows: [
          ['渠道', 'Slack · #growth-weekly'],
          ['范围', '9 位成员（增长组 + 数据组）'],
          ['摘要', '收入 ¥4.82M（−8.4%）· 激活 34.7%（+2.1pt）'],
          ['风控', '外发内容 / 含客户数量 · 需人工确认'],
        ],
        form: [
          { name: 'channel', label: '发布渠道', type: 'select', options: ['#growth-weekly', '#growth-alerts', '仅存草稿'], value: '#growth-weekly' },
          { name: 'delay', label: '定时（可选）', type: 'text', value: '', placeholder: '立即发布 / 例如 周一 09:00' },
          { name: 'attach', label: '附带客户名单（仅内部）', type: 'check', value: false },
        ],
        okText: '批准并发布', note: '审批结果会写回对话，Agent 继续执行。',
      },
      afterApproved: '已发布到 **#growth-weekly**，9 位成员可见。归档链接已写入「团队报表」。我还把 3 条告警拆成了 3 个负责人待办。',
      afterRejected: '好的，**已取消发布**，草稿保留在对话里。你可以继续修改内容，或让我改成「仅存草稿」。',
      followups: ['改成只发给自己', '把客户数量从摘要里去掉', '生成一份给管理层的版本'],
    };
  }

  function planForm(q) {
    const ap = approvalId();
    return {
      title: '结构化表单',
      thinking: ['识别任务：创建投放计划', '需要 4 个必填项', '生成结构化表单，等待补充'],
      tools: [
        { name: 'query_warehouse', args: 'channel_cpa_last_30d', duration: 520 },
        { name: 'update_crm', args: 'draft · campaign', duration: 420, scope: 'crm: campaign · 需要审批' },
      ],
      beforeText: '我可以直接建这个投放计划，但还差几个只有你能拍板的参数。请补齐下面的表单，我会按你填的值执行。',
      approval: {
        type: 'approval', id: ap, icon: '⌘', kindLabel: '结构化表单 · 补充信息',
        title: '新建投放计划 · 华东区 Q4 拉新',
        desc: '参考近 30 天 CPA 基线 ¥186，低于基线 12% 为健康。',
        rows: [
          ['建议预算', '¥120,000 / 月（可调）'],
          ['目标', '激活率 ≥ 36% · CPA ≤ ¥200'],
          ['冲突检查', '无进行中的同人群计划'],
        ],
        form: [
          { name: 'budget', label: '月预算（元）', type: 'text', value: '120000' },
          { name: 'geo', label: '定向区域', type: 'select', options: ['华东（沪苏浙皖）', '华南', '全国'], value: '华东（沪苏浙皖）' },
          { name: 'cap', label: 'CPA 上限（元）', type: 'text', value: '200' },
          { name: 'guard', label: '开启自动止损', type: 'check', value: true },
        ],
        okText: '确认创建', note: '创建后可随时在「投放」页暂停。',
      },
      afterApproved: '已按你的参数创建**华东区 Q4 拉新**计划：预算 ¥120,000/月、CPA 上限 ¥200、启用自动止损。首轮数据将在 6 小时后可读。',
      afterRejected: '已取消创建，没有产生任何费用。需要我先给一个更保守的预算方案吗？',
      followups: ['把预算改成 8 万', '先小流量试投 3 天', '设置每日消耗告警'],
    };
  }

  function planAdvice(q) {
    return {
      title: '增长建议',
      thinking: ['综合页面上下文：收入↓ / 激活↑ / 流失↑', '评估「先修复再扩量」的组合', '排除口径噪声'],
      tools: [
        { name: 'query_warehouse', args: 'funnel_step_dropoff by device', duration: 600 },
        { name: 'search_docs', args: '扩量 SOP / 容量评估', duration: 420 },
      ],
      text: '先别扩量。现在扩量会把「低激活人群」按更高单价买进来，**放大亏损**。',
      timelineBlock: {
        type: 'rich', kind: 'timeline', title: '建议的 21 天路径', items: [
          { time: '第 1–2 天', title: '修复续费触达', desc: '12 家客户人工触达 + 话术 v2.3', state: 'done' },
          { time: '第 3–7 天', title: '投放止损', desc: '暂停 2 个低效计划，CPA 回到 ¥190 以下', state: 'active' },
          { time: '第 8–14 天', title: '激活率补口径', desc: '补齐移动端 3 个埋点，验证漏斗断层', state: '' },
          { time: '第 15–21 天', title: '再评估扩量', desc: '以修正后的激活率作为准入条件', state: '' },
        ]
      },
      text2: '**门槛条件**：当「企业版续费提前期 < 30 天」的客户数降到 5 家以内，且付费投放激活率回到 32% 以上，再谈扩量。',
      actions: [{ label: '高亮流失指标', host: '#kpi-churn' }],
      followups: ['把路径变成任务清单', '谁该负责第一步？', '给我一个拒绝扩量的论据'],
    };
  }

  async function runTurn(text) {
    if (S.busy) return;
    S.busy = true;
    S.turnPending = false;
    S.unseen = 0;
    S.abort = new AbortController();
    S.turn = (S.turn || 0) + 1;
    const turnId = S.turn;
    updateComposerState();
    updateSub('<i class="live-dot"></i>正在处理 · 工具链运行中');

    const p = plan(text);
    const msg = ensureAssistant();
    // The thinking + tool chain live in their own layer so streaming markdown can
    // re-render freely without dropping them. They are cleared once the turn settles.
    const host = document.createElement('div');
    host.className = 'msg-blocks';
    host.dataset.layer = 'live';
    const msgEl = threadInner.querySelector('[data-msg-id="' + msg.id + '"] .msg-body');
    if (msgEl) msgEl.appendChild(host);

    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.innerHTML = '<span class="spinner"></span><span class="thinking-text">' + p.thinking[0] + '</span>';
    host.appendChild(thinking);
    maybeScroll();

    // rotate thinking labels
    let ti = 0;
    const thinkTimer = setInterval(() => {
      ti = (ti + 1) % p.thinking.length;
      const el = thinking.querySelector('.thinking-text');
      if (el) el.textContent = p.thinking[ti];
    }, 760);

    await sleep(420 * store.prefs.speed);
    if (S.abort.signal.aborted) { clearInterval(thinkTimer); finishTurn(msg, turnId); return; }

    const tools = document.createElement('div');
    tools.className = 'toolset';
    tools.dataset.layer = 'live';
    tools.dataset.turn = msg.id;
    const toolHead = document.createElement('div');
    toolHead.className = 'rich-head';
    toolHead.innerHTML = '<b>工具调用链</b><span class="thinking-text">Chain of Thought · 可折叠</span><span class="rich-tag">live</span>';
    tools.appendChild(toolHead);
    host.appendChild(tools);
    msg.liveHost = host;

    for (const t of p.tools) {
      if (S.abort.signal.aborted) break;
      await animateToolCall(tools, t.name, t.args, t);
      await sleep(100 * store.prefs.speed);
    }
    clearInterval(thinkTimer);
    thinking.remove();
    if (S.abort.signal.aborted) { finishTurn(msg, turnId); return; }

    const seg = { type: 'textSeg', live: true, done: false, text: '' };
    msg.text = '';
    msg.blocks.push(seg);

    if (p.beforeText) {
      await streamText(msg, p.beforeText, { seg });
      if (S.abort.signal.aborted) { finishTurn(msg, turnId); return; }
    }
    const richPush = async (blk) => {
      if (!blk) return;
      // text after the rich block streams into a fresh segment
      msg.blocks.push(blk);
      const next = { type: 'textSeg', live: false, done: true, text: '' };
      msg.blocks.push(next);
      msg._pendingSeg = next;
      renderThread(); await sleep(40); maybeScroll(); await sleep(220);
    };
    await richPush(p.metricBlock);
    await richPush(p.chartBlock);
    await richPush(p.diffBlock);
    await richPush(p.timelineBlock);

    if (p.approval) {
      const ap = p.approval;
      ap.decision = null;
      msg.blocks.push(ap);
      if (!p.beforeText) {
        const next = { type: 'textSeg', live: false, done: true, text: '' };
        msg.blocks.push(next);
        msg._pendingSeg = next;
      }
      msg.status = 'paused';
      renderThread();
      maybeScroll();
      updateSub('<i class="live-dot"></i>等待你的确认');
      const decision = await waitApproval(ap);
      if (decision === null) { // stopped while waiting
        ap.decision = 'rejected';
        ap.note = '已中断，未执行。';
        renderThread();
        finishTurn(msg, turnId);
        return;
      }
      ap.decision = decision;
      ap.note = decision === 'approved' ? '已记录：批准 · ' + timeLabel(Date.now()) : '已记录：拒绝 · ' + timeLabel(Date.now());
      renderThread();
      const follow = decision === 'approved' ? p.afterApproved : p.afterRejected;
      if (follow) {
        await streamText(msg, follow, { seg: msg._pendingSeg });
      }
    } else if (p.text) {
      const activeSeg = msg._pendingSeg || seg;
      await streamText(msg, p.text, { seg: activeSeg });
      if (S.abort.signal.aborted) { finishTurn(msg, turnId); return; }
      if (p.text2) {
        await sleep(420 * store.prefs.speed);
        await streamText(msg, p.text2, { seg: activeSeg });
      }
    }

    msg.status = 'done';
    msg.followups = p.followups || [];
    msg.actions = p.actions || [];
    if (msg.actions.length) {
      msg.followups = msg.followups.concat(msg.actions.map(a => a.label));
    }
    renderThread();
    finishTurn(msg, turnId);
  }

  function finishTurn(msg, turnId) {
    if (turnId != null && S.turn != null && turnId !== S.turn) {
      DBG('finish-stale', { turnId, current: S.turn });
      return; // a newer turn owns the composer now
    }
    const stopped = !!(S.abort && S.abort.signal.aborted);
    DBG('finish', { stopped, turn: turnId });
    S.busy = false;
    S.abort = null;
    updateComposerState();
    updateSub('<i class="live-dot"></i>在线 · 上下文已注入');
    // fade out this turn's "live" strip (thinking / tool chain) once the answer is settled
    const scope = msg && msg.liveHost ? [msg.liveHost] : $$('[data-layer="live"]');
    scope.forEach((el, i) => {
      if (!el || !el.isConnected) return;
      el.style.transition = 'opacity .3s var(--ease), transform .3s var(--ease)';
      el.style.opacity = '0';
      el.style.transform = 'translateY(-3px)';
      setTimeout(() => {
        el.remove();
        // keep the reading position anchored after the live strip collapses
        if (store.prefs.autoScroll !== false) scrollBottom(false);
      }, 320 + i * 20);
    });
    const s = currentSession();
    if (s.messages.length && s.title === '新对话') {
      const first = s.messages.find(m => m.role === 'user');
      s.title = (first && first.text ? first.text : '新对话').slice(0, 26);
      save();
      renderSessionList();
    }
    save();
    if (!stopped && S.queue.length) {
      const next = S.queue.shift();
      renderQueue();
      setTimeout(() => {
        toast('ok', '正在发送排队消息', esc(next.text.slice(0, 24)));
        sendMessage(next.text);
      }, 420);
    }
  }

  function waitApproval(block) {
    return new Promise(resolve => {
      S.approved = { id: block.id, resolve };
      const onAbort = () => {
        if (S.approved && S.approved.id === block.id) { S.approved = null; resolve(null); }
      };
      if (S.abort) S.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function decideApproval(id, decision, formVals) {
    const found = findApproval(id);
    if (!found) return;
    const ap = S.approved && S.approved.id === id ? S.approved : null;
    if (ap) {
      if (formVals && Object.keys(formVals).length) {
        ap.resolveWith = formVals;
      }
      S.approved = null;
      ap.resolve(decision);
    } else {
      // already decided / stale
      found.block.decision = decision;
      renderThread();
    }
    toast(decision === 'approved' ? 'ok' : 'warn',
      decision === 'approved' ? '已批准' : '已拒绝',
      decision === 'approved' ? 'Agent 将继续执行并回报结果。' : 'Agent 已停止该操作，草稿已保留。');
  }

  function readApprovalForm(id) {
    const el = threadInner.querySelector('[data-approval="' + id + '"]');
    if (!el) return {};
    const vals = {};
    el.querySelectorAll('[data-field]').forEach(f => {
      vals[f.dataset.field] = f.type === 'checkbox' ? f.checked : f.value;
    });
    return vals;
  }

  /* ==========================================================
     07 composer & queue
     ========================================================== */
  function updateComposerState() {
    const hasText = inputEl.value.trim().length > 0 || S.attachments.length > 0;
    sendBtn.classList.toggle('is-stop', S.busy);
    sendBtn.disabled = !S.busy && !hasText;
    sendBtn.setAttribute('aria-label', S.busy ? '中断生成' : '发送消息');
    sendBtn.title = S.busy ? '中断生成（Stop）' : '发送（Enter）';
    D.queueTray.hidden = S.queue.length === 0;
    $('#queueCount').textContent = S.queue.length;
    const n = inputEl.value.length;
    D.charCount.hidden = n < 40;
    D.charCount.textContent = n + '/' + MAX_INPUT;
    D.charCount.classList.toggle('warn', n > MAX_INPUT - 100);
  }

  function renderQueue() {
    D.queueList.innerHTML = S.queue.map((q, i) =>
      '<li class="queue-item"><span class="q-ix">#' + (i + 1) + '</span>' +
      '<span class="q-text">' + esc(q.text) + '</span>' +
      '<button data-qdel="' + q.id + '" aria-label="移除排队消息">✕</button></li>'
    ).join('');
    D.queueTray.hidden = S.queue.length === 0;
    $('#queueCount').textContent = S.queue.length;
    updateComposerState();
  }

  function renderAttachments() {
    if (!S.attachments.length) { D.attachments.hidden = true; D.attachments.innerHTML = ''; return; }
    D.attachments.hidden = false;
    D.attachments.innerHTML = S.attachments.map(f =>
      '<span class="att">' +
      (f.dataUrl ? '<img class="att-thumb" src="' + f.dataUrl + '" alt="">' : '<span class="att-ic">' + esc((f.name.split('.').pop() || 'file').slice(0, 4).toUpperCase()) + '</span>') +
      '<span class="att-name" title="' + esc(f.name) + '">' + esc(f.name) + '</span>' +
      '<span class="att-size">' + bytes(f.size) + '</span>' +
      '<button class="att-x" data-attx="' + f.id + '" aria-label="移除附件">✕</button></span>'
    ).join('');
    updateComposerState();
  }

  function addFiles(fileList) {
    Array.from(fileList || []).forEach(file => {
      if (S.attachments.length >= MAX_FILES) { toast('warn', '附件数量超限', '最多 ' + MAX_FILES + ' 个文件。'); return; }
      if (file.size > MAX_FILE_SIZE) { toast('err', '文件过大', file.name + ' 超过 4MB。'); return; }
      const item = { id: uid('f'), name: file.name, size: file.size, type: file.type, dataUrl: '' };
      S.attachments.push(item);
      if (/^image\//.test(file.type)) {
        const fr = new FileReader();
        fr.onload = () => { item.dataUrl = String(fr.result); renderAttachments(); };
        fr.readAsDataURL(file);
      }
    });
    renderAttachments();
  }

  function sendMessage(text, opts) {
    opts = opts || {};
    const t = String(text == null ? inputEl.value : text).trim();
    if (!t) return;
    if (S.busy || S.turnPending) {
      S.queue.push({ id: uid('q'), text: t, ts: Date.now() });
      renderQueue();
      toast('warn', '已加入队列', 'Agent 完成后自动发送（队列 ' + S.queue.length + '）。');
      if (inputEl.value.trim() === t) { inputEl.value = ''; autoGrow(); }
      updateComposerState();
      return;
    }
    if (t.length > MAX_INPUT) { toast('err', '内容过长', '请控制在 ' + MAX_INPUT + ' 字符以内。'); return; }

    const files = S.attachments.map(f => ({ name: f.name, size: f.size }));
    S.attachments = [];
    renderAttachments();
    if (inputEl.value.trim() === t) { inputEl.value = ''; autoGrow(); }

    const payload = t;
    appendMessage({
      id: uid('m'), role: 'user', text: payload, ts: Date.now(),
      files: files.length ? files : null,
      context: contextPayload(),
    });
    if (currentSession().title === '新对话') {
      currentSession().title = payload.slice(0, 26);
      renderSessionList();
    }
    save();
    S.turnPending = true;
    updateComposerState();
    setTimeout(() => {
      S.turnPending = false;
      runTurn(payload).catch(err => {
        console.error('turn failed', err);
        S.busy = false;
        updateComposerState();
        toast('err', '生成失败', '已保留本轮到目前的输出。');
        const last = S.messages[S.messages.length - 1];
        if (last && last.role === 'assistant' && last.status === 'streaming') { last.status = 'done'; renderThread(); }
      });
    }, 100);
  }

  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(150, inputEl.scrollHeight) + 'px';
  }

  /* ==========================================================
     08 window chrome: modes, drag, resize, sheet
     ========================================================== */
  function isMobile() {
    return store.device === 'mobile' || (store.device === 'desktop' && window.matchMedia('(max-width: 767px)').matches);
  }

  function applyTheme() {
    html.dataset.theme = store.theme;
    const seg = $('#themeSeg');
    if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.theme === store.theme));
  }
  function applyMotion() {
    html.dataset.motion = store.prefs.reduceMotion ? 'reduce' : 'full';
  }
  function applyDevice() {
    html.dataset.device = store.device;
  }

  function geometryFor(mode) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const mobile = isMobile();
    if (mode === 'full') return { w: vw - 24, h: vh - 24, top: 12, left: 12 };
    if (mode === 'pip') {
      const w = mobile ? vw - 16 : 320, h = mobile ? 300 : 380;
      return { w, h, left: Math.max(8, vw - w - 22), top: Math.max(8, vh - h - 92) };
    }
    if (mobile) {
      const h = Math.round(vh * store.sheetH);
      return { w: vw - 16, h, left: 8, top: vh - h - 8 };
    }
    const w = clamp(store.geo.w || 480, 360, Math.min(720, vw - 24));
    const h = Math.min(store.geo.h || 800, vh - 96);
    let left = store.geo.l;
    let top = store.geo.t;
    if (left == null) {
      const corner = store.geo.corner || 'br';
      left = /l/.test(corner) ? 18 : vw - w - 22;
      top = /t/.test(corner) ? 76 : vh - h - 86;
    }
    left = clamp(left, 8, Math.max(8, vw - w - 8));
    top = clamp(top, 8, Math.max(8, vh - h - 8));
    return { w, h, left, top };
  }

  function setMode(mode, opts) {
    opts = opts || {};
    const prev = store.mode;
    if (mode === 'closed') { closePanel(opts); return; }
    store.mode = mode;
    html.dataset.mode = mode;
    agentEl.dataset.mode = mode;
    agentEl.hidden = false;

    const mobile = isMobile();
    if (mobile && (mode === 'dock' || mode === 'float' || mode === 'full')) {
      // mobile always renders as bottom sheet; keep requested mode for restored semantics
    }

    // geometry
    if (mode === 'dock' || mode === 'float') {
      const g = geometryFor(mode);
      if (!mobile) {
        store.geo.w = Math.round(g.w);
        store.geo.h = Math.round(g.h);
        if (mode === 'float') { store.geo.l = Math.round(g.left); store.geo.t = Math.round(g.top); }
      }
      agentEl.style.setProperty('--agent-w', g.w + 'px');
      agentEl.style.setProperty('--agent-h', g.h + 'px');
      agentEl.style.setProperty('--float-left', g.left + 'px');
      agentEl.style.setProperty('--float-top', g.top + 'px');
      agentEl.style.setProperty('--float-right', 'auto');
      agentEl.style.setProperty('--sheet-h', Math.round(store.sheetH * 100) + 'vh');
      html.style.setProperty('--bubble-w', g.w + 'px');
    } else {
      agentEl.style.setProperty('--agent-w', '');
      agentEl.style.setProperty('--agent-h', '');
    }
    document.querySelectorAll('.mode-btn').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.setMode === mode));
    });
    $$('.demo-grid button[data-set-mode]').forEach(b => b.classList.toggle('on', b.dataset.setMode === mode));
    $('#fab').setAttribute('aria-expanded', 'true');
    launcherEl.hidden = true;

    if (!agentEl.classList.contains('open')) {
      agentEl.classList.add('open');
      requestAnimationFrame(() => scrollBottom(false));
    }
    agentEl.classList.remove('minimizing');
    agentEl.hidden = false;

    // a11y: overlay-like modes trap the page
    const modal = mobile || mode === 'float' || mode === 'pip';
    agentEl.setAttribute('aria-modal', String(modal));
    D.backdrop.hidden = !modal;
    requestAnimationFrame(() => D.backdrop.classList.toggle('show', modal));
    hostEl.inert = modal;
    if (modal) {
      if (document.activeElement && !agentEl.contains(document.activeElement)) S.lastFocus = document.activeElement;
      setTimeout(() => inputEl.focus({ preventScroll: true }), 180);
    }
    $('#agentDesc').innerHTML = '<i class="live-dot"></i>在线 · 上下文已注入';
    launcherEl.hidden = true;

    if (prev !== mode && !opts.boot) toast('ok', '已切换为' + modeLabel(mode), modeHint(mode));
    save();
    renderContextList();
  }

  function modeLabel(m) {
    return ({ dock: '停靠', float: '浮动', pip: '画中画', full: '全屏', closed: '悬浮球' })[m] || m;
  }
  function modeHint(m) {
    return ({ dock: '页面内容自动让出侧边空间，像工作台。', float: 'Overlay 模式：捕获焦点，Esc 可收起。', pip: '画中画：继续旁听，随时展开。', full: '全屏工作台，专注长任务。', closed: '已折叠为悬浮球。' })[m] || '';
  }

  function openPanel(mode) {
    S.demoPrevMode = null;
    if (!store.mode || store.mode === 'closed') {
      setMode(mode || (window.innerWidth < 768 ? 'float' : 'float'), { silent: false });
    } else {
      setMode(mode || store.mode);
    }
  }
  function closePanel(opts) {
    if (store.mode === 'closed') return;
    store.mode = 'closed';
    html.dataset.mode = 'closed';
    agentEl.classList.add('minimizing');
    agentEl.classList.remove('open');
    setTimeout(() => {
      agentEl.hidden = true;
      agentEl.dataset.mode = 'closed';
      agentEl.classList.remove('minimizing');
    }, 210);
    launcherEl.hidden = false;
    launcherEl.dataset.state = 'closed';
    D.backdrop.classList.remove('show');
    setTimeout(() => { D.backdrop.hidden = true; }, 240);
    hostEl.inert = false;
    $('#fab').setAttribute('aria-expanded', 'false');
    document.querySelectorAll('.mode-btn').forEach(b => b.setAttribute('aria-pressed', 'false'));
    if (S.lastFocus && typeof S.lastFocus.focus === 'function') {
      try { S.lastFocus.focus({ preventScroll: true }); } catch (e) {}
    }
    save();
    if (!opts || !opts.silent) toast('ok', '已收起为悬浮球', '位置与对话已保存，点悬浮球继续。');
  }

  /* ---- FAB drag & snap ---- */
  function positionLauncher(corner) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const size = 56, pad = 16;
    const left = /l/.test(corner) ? pad : vw - size - pad - 6;
    const top = /t/.test(corner) ? 72 : vh - size - pad - 6;
    launcherEl.style.left = left + 'px';
    launcherEl.style.top = top + 'px';
    launcherEl.style.right = 'auto';
    launcherEl.style.bottom = 'auto';
  }
  function initLauncher() {
    if (!store.geo.corner) store.geo.corner = 'br';
    if (isMobile()) {
      launcherEl.style.left = 'auto'; launcherEl.style.top = 'auto';
      launcherEl.style.right = '14px'; launcherEl.style.bottom = '14px';
    } else {
      positionLauncher(store.geo.corner);
    }
    let drag = null;
    let moved = false;
    fabEl.addEventListener('pointerdown', e => {
      if (e.button !== undefined && e.button !== 0) return;
      const r = launcherEl.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, ox: r.left, oy: r.top, moved: false };
      moved = false;
      fabEl.setPointerCapture && fabEl.setPointerCapture(e.pointerId);
      launcherEl.classList.add('dragging');
      e.preventDefault();
    });
    fabEl.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) { moved = true; drag.moved = true; }
      if (!moved) return;
      const w = launcherEl.offsetWidth, h = launcherEl.offsetHeight;
      launcherEl.style.left = clamp(drag.ox + dx, 6, window.innerWidth - w - 6) + 'px';
      launcherEl.style.top = clamp(drag.oy + dy, 6, window.innerHeight - h - 6) + 'px';
      launcherEl.style.right = 'auto';
      launcherEl.style.bottom = 'auto';
    });
    const endDrag = e => {
      if (!drag) return;
      const wasMoved = moved;
      launcherEl.classList.remove('dragging');
      fabEl.releasePointerCapture && drag && fabEl.releasePointerCapture(e.pointerId);
      drag = null;
      if (!wasMoved) { openPanel(store.mode === 'closed' ? 'float' : store.mode); return; }
      // snap to nearest corner
      const r = launcherEl.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const corner = (cx < window.innerWidth / 2 ? 'l' : 'r') === 'l' ? (cy < window.innerHeight / 2 ? 'tl' : 'bl') : (cy < window.innerHeight / 2 ? 'tr' : 'br');
      // note: first char must be side, second vertical → build explicitly
      const side = cx < window.innerWidth / 2 ? 'l' : 'r';
      const vert = cy < window.innerHeight / 2 ? 't' : 'b';
      const finalCorner = vert + side;
      store.geo.corner = finalCorner;
      launcherEl.style.transition = 'left .3s var(--ease), top .3s var(--ease)';
      positionLauncher(finalCorner);
      setTimeout(() => { launcherEl.style.transition = ''; }, 320);
      save();
    };
    fabEl.addEventListener('pointerup', endDrag);
    fabEl.addEventListener('pointercancel', () => { drag = null; launcherEl.classList.remove('dragging'); });
    fabEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPanel('float'); }
    });
  }

  /* ---- panel drag (float) ---- */
  function initPanelDrag() {
    let drag = null;
    D.head.addEventListener('pointerdown', e => {
      if (isMobile()) return;
      if (e.target.closest('button, a, input, select')) return;
      if (store.mode !== 'float' && store.mode !== 'dock' && store.mode !== 'pip') return;
      const r = agentEl.getBoundingClientRect();
      if (store.mode === 'dock' || store.mode === 'pip') {
        // dragging a docked / PiP panel detaches it into overlay mode
        const w = Math.min(store.mode === 'pip' ? 420 : r.width, window.innerWidth - 16);
        const h = Math.min(store.mode === 'pip' ? 620 : r.height, window.innerHeight - 16);
        const left = clamp(r.left, 8, window.innerWidth - w - 8);
        const top = clamp(r.top, 8, window.innerHeight - h - 8);
        agentEl.style.setProperty('--agent-w', w + 'px');
        agentEl.style.setProperty('--agent-h', h + 'px');
        agentEl.style.setProperty('--float-left', left + 'px');
        agentEl.style.setProperty('--float-top', top + 'px');
        agentEl.style.setProperty('--float-right', 'auto');
        store.geo.w = Math.round(w); store.geo.h = Math.round(h);
        store.geo.l = Math.round(left); store.geo.t = Math.round(top);
        setMode('float', { silent: true });
        const r1 = agentEl.getBoundingClientRect();
        drag = { x: e.clientX, y: e.clientY, ox: r1.left, oy: r1.top };
        toast('info', '已切换为浮动模式', '松手后会吸附到最近的屏幕边缘。');
      } else {
        drag = { x: e.clientX, y: e.clientY, ox: r.left, oy: r.top };
      }
      D.head.classList.add('dragging');
      D.head.setPointerCapture && D.head.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    D.head.addEventListener('pointermove', e => {
      if (!drag) return;
      const w = agentEl.offsetWidth, h = agentEl.offsetHeight;
      const left = clamp(drag.ox + e.clientX - drag.x, 6, window.innerWidth - w - 6);
      const top = clamp(drag.oy + e.clientY - drag.y, 6, window.innerHeight - h - 6);
      agentEl.style.setProperty('--float-left', left + 'px');
      agentEl.style.setProperty('--float-top', top + 'px');
      agentEl.style.setProperty('--float-right', 'auto');
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      D.head.classList.remove('dragging');
      const r = agentEl.getBoundingClientRect();
      store.geo.l = Math.round(r.left);
      store.geo.t = Math.round(r.top);
      store.geo.corner = (r.top + r.height / 2 < window.innerHeight / 2 ? 't' : 'b') + (r.left + r.width / 2 < window.innerWidth / 2 ? 'l' : 'r');
      // edge snap
      const snap = 22;
      let left = r.left, top = r.top;
      if (Math.abs(r.left) < snap) left = 8;
      if (Math.abs(window.innerWidth - r.right) < snap) left = window.innerWidth - r.width - 8;
      if (Math.abs(r.top) < snap) top = 8;
      if (Math.abs(window.innerHeight - r.bottom) < snap) top = window.innerHeight - r.height - 8;
      if (left !== r.left || top !== r.top) {
        agentEl.style.setProperty('--float-left', left + 'px');
        agentEl.style.setProperty('--float-top', top + 'px');
        store.geo.l = Math.round(left); store.geo.t = Math.round(top);
      }
      save();
    };
    D.head.addEventListener('pointerup', end);
    D.head.addEventListener('pointercancel', end);
  }

  /* ---- panel resize ---- */
  function initResize() {
    const handle = $('#agentResize');
    let r = null;
    handle.addEventListener('pointerdown', e => {
      if (isMobile()) return;
      r = { x: e.clientX, w: agentEl.offsetWidth };
      handle.classList.add('active');
      handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!r) return;
      const w = clamp(r.w - (e.clientX - r.x), 360, Math.min(720, window.innerWidth - 40));
      agentEl.style.setProperty('--agent-w', w + 'px');
      agentEl.style.setProperty('--bubble-w', w + 'px');
      store.geo.w = Math.round(w);
    });
    handle.addEventListener('pointerup', () => { if (!r) return; r = null; handle.classList.remove('active'); save(); });
    handle.addEventListener('pointercancel', () => { r = null; handle.classList.remove('active'); });
  }

  /* ---- mobile sheet drag ---- */
  function initSheet() {
    let drag = null;
    D.head.addEventListener('pointerdown', e => {
      if (!isMobile()) return;
      if (e.target.closest('button, a, input, select')) return;
      drag = { y: e.clientY, h: agentEl.offsetHeight };
      D.head.setPointerCapture && D.head.setPointerCapture(e.pointerId);
      D.head.classList.add('dragging');
      e.preventDefault();
    });
    D.head.addEventListener('pointermove', e => {
      if (!drag) return;
      const h = drag.h + (drag.y - e.clientY);
      const min = 88;
      const max = window.innerHeight - 16;
      const hh = clamp(h, min, max);
      agentEl.style.height = hh + 'px';
      if (hh < window.innerHeight * 0.2) {
        $('#thread').style.opacity = '0';
        $('#composer').style.opacity = '0';
      } else {
        $('#thread').style.opacity = '';
        $('#composer').style.opacity = '';
      }
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      D.head.classList.remove('dragging');
      $('#thread').style.opacity = '';
      $('#composer').style.opacity = '';
      const h = agentEl.offsetHeight;
      const vh = window.innerHeight;
      const ratio = h / vh;
      if (ratio < 0.16) { closePanel(); return; }
      const snaps = [0.42, 0.5, 0.9];
      const target = snaps.reduce((a, b) => Math.abs(b - ratio) < Math.abs(a - ratio) ? b : a, snaps[0]);
      store.sheetH = target;
      agentEl.style.setProperty('--sheet-h', Math.round(target * 100) + 'vh');
      agentEl.style.height = '';
      save();
    };
    D.head.addEventListener('pointerup', end);
    D.head.addEventListener('pointercancel', end);
  }

  /* ==========================================================
     09 modals, toasts, a11y, shortcuts
     ========================================================== */
  let toastTimer = [];
  function toast(tone, title, sub) {
    const el = document.createElement('div');
    el.className = 'toast ' + (tone || '');
    const icon = tone === 'ok' ? '✓' : tone === 'warn' ? '!' : tone === 'err' ? '✕' : 'i';
    el.innerHTML = '<span class="toast-ic">' + icon + '</span><span><b>' + title + '</b>' + (sub ? ' <small>' + sub + '</small>' : '') + '</span>';
    D.toasts.appendChild(el);
    const t1 = setTimeout(() => { el.classList.add('out'); const t2 = setTimeout(() => el.remove(), 240); toastTimer.push(t2); }, 3200);
    toastTimer.push(t1);
    while (D.toasts.children.length > 3) D.toasts.firstChild.remove();
  }

  function openModal(id) {
    const m = document.getElementById(id);
    if (!m) return;
    if (!m.hidden) return;
    m.hidden = false;
    S.modals.push(id);
    const card = m.querySelector('.modal-card');
    const focusables = card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusables[0]) setTimeout(() => focusables[0].focus({ preventScroll: true }), 60);
    if (id === 'historyModal') renderSessionList();
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (!m || m.hidden) return;
    m.hidden = true;
    S.modals = S.modals.filter(x => x !== id);
    if (modalReturn && typeof modalReturn.focus === 'function') { try { modalReturn.focus({ preventScroll: true }); } catch (e) {} modalReturn = null; }
  }
  let modalReturn = null;

  function renderSessionList() {
    if (!D.sessionList) return;
    if (!store.sessions.length) {
      D.sessionList.innerHTML = '<li class="empty-history">还没有历史对话</li>';
      return;
    }
    D.sessionList.innerHTML = store.sessions.map(s => {
      const first = s.messages.find(m => m.role === 'user');
      const title = s.title && s.title !== '新对话' ? s.title : (first && first.text) || '空对话';
      return '<li class="session-item' + (s.id === store.currentId ? ' current' : '') + '" data-session="' + s.id + '" tabindex="0" role="button">' +
        '<span class="session-dot"></span><span class="session-main">' +
        '<span class="session-title">' + esc(title) + '</span>' +
        '<span class="session-meta"><span>' + dayLabel(s.updatedAt || s.createdAt) + '</span><span>·</span><span>' + s.messages.length + ' 条消息</span></span>' +
        '</span><button class="session-del" data-del-session="' + s.id + '" aria-label="删除对话">✕</button></li>';
    }).join('');
  }

  function loadSession(id) {
    if (S.busy) { stopGeneration(); }
    store.currentId = id;
    S.messages = currentSession().messages;
    S.queue = [];
    renderThread(true);
    renderQueue();
    renderSessionList();
    save();
    if (isMobile() || store.mode === 'closed') openPanel('float');
    closeModal('historyModal');
    toast('ok', '已恢复对话', '历史与窗口状态都已还原。');
  }

  function deleteSession(id) {
    store.sessions = store.sessions.filter(s => s.id !== id);
    if (store.currentId === id) {
      if (store.sessions[0]) { store.currentId = store.sessions[0].id; S.messages = store.sessions[0].messages; }
      else { newSession({ silent: true }); }
    }
    S.messages = currentSession().messages;
    renderThread(true); renderSessionList(); save();
  }

  /* focus trap */
  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const activeModal = S.modals.length ? document.getElementById(S.modals[S.modals.length - 1]) : null;
    const scope = activeModal || agentEl;
    const list = Array.from(scope.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null && el.getClientRects().length);
    if (!list.length) return;
    const first = list[0], last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === scope)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function overlayTrapActive() {
    return agentEl.getAttribute('aria-modal') === 'true' && !agentEl.hidden && store.mode !== 'closed';
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      if (S.modals.length) { trapFocus(e); return; }
      if (overlayTrapActive()) trapFocus(e);
    }
  });

  /* shortcuts */
  document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'j' || e.key === 'J')) {
      e.preventDefault();
      if (store.mode === 'closed') openPanel('float'); else closePanel();
      return;
    }
    if (e.altKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      newSession();
      if (store.mode === 'closed') openPanel('float');
      toast('ok', '已新建对话', '上下文仍然可用。');
      return;
    }
    if (e.key === 'Escape') {
      if (S.modals.length) { const id = S.modals[S.modals.length - 1]; closeModal(id); return; }
      if (D.ctxPop && !D.ctxPop.hidden) { toggleCtx(false); return; }
      if (D.demoPanel && !D.demoPanel.hidden) { toggleDemo(false); return; }
      if (window.speechSynthesis && window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); }
      if (store.mode !== 'closed' && !isMobile()) closePanel();
      else if (store.mode !== 'closed' && isMobile()) closePanel();
    }
  });

  document.addEventListener('click', e => {
    const closeBtn = e.target.closest('[data-close-modal]');
    if (closeBtn) { closeModal(closeBtn.dataset.closeModal); return; }
    const modeBtn = e.target.closest('[data-set-mode]');
    if (modeBtn) { e.preventDefault(); setMode(modeBtn.dataset.setMode); return; }
    const themeBtn = e.target.closest('#themeSeg button');
    if (themeBtn) { store.theme = themeBtn.dataset.theme; applyTheme(); try { localStorage.setItem(STORE_KEY + '.themePinned', '1'); } catch (e) {} save(); toast('ok', store.theme === 'light' ? '已切换为浅色' : '已切换为深色'); return; }
    const devBtn = e.target.closest('[data-device]');
    if (devBtn) {
      store.device = devBtn.dataset.device;
      applyDevice();
      $$('.demo-grid button[data-device]').forEach(b => b.classList.toggle('on', b === devBtn));
      save();
      if (store.device === 'mobile') toast('warn', '已模拟移动端', '面板变为底部工作表（Bottom Sheet）。');
      else toast('ok', '已切回桌面端', '窗口形态恢复为浮动/停靠。');
      if (store.mode !== 'closed') setMode(store.mode === 'full' ? 'float' : store.mode);
      return;
    }
    if (e.target.closest('.js-demo-trigger')) {
      const t = e.target.closest('.js-demo-trigger');
      const prompt = t.dataset.prompt;
      openPanel(t.dataset.mode || 'float');
      if (prompt) setTimeout(() => sendMessage(prompt), 380);
      return;
    }
  });

  /* ==========================================================
     Event wiring
     ========================================================== */
  function wire() {
    /* composer */
    inputEl.addEventListener('input', () => { autoGrow(); updateComposerState(); });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing) {
        e.preventDefault();
        if (S.busy) { sendMessage(); } // queue
        else if (inputEl.value.trim()) sendMessage();
      }
      if (e.key === 'Tab' && !e.shiftKey && inputEl.value.startsWith('/')) {
        // simple slash completion
        const cmds = ['/analyze ', '/chart ', '/diff ', '/report ', '/reset '];
        const match = cmds.find(c => c.startsWith(inputEl.value));
        if (match) { e.preventDefault(); inputEl.value = match; autoGrow(); updateComposerState(); }
      }
    });
    sendBtn.addEventListener('click', () => {
      if (S.busy) { stopGeneration(); return; }
      sendMessage();
    });

    document.querySelectorAll('.cmd-chip[data-cmd]').forEach(b => {
      b.addEventListener('click', () => {
        inputEl.value = b.dataset.cmd + ' ';
        inputEl.focus();
        autoGrow();
        updateComposerState();
      });
    });
    $('#cmdMore').addEventListener('click', () => {
      const cmds = ['/analyze ', '/chart ', '/diff ', '/report ', '/export ', '/reset '];
      inputEl.value = cmds[(Math.floor(Math.random() * cmds.length))] + ' ';
      inputEl.focus(); autoGrow(); updateComposerState();
      toast('info', '已插入指令', 'Shift+Tab 可切换为其他指令（演示）。');
    });

    /* attachments */
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.accept = 'image/*,.pdf,.csv,.md,.txt,.json';
    fileInput.hidden = true;
    document.body.appendChild(fileInput);
    $('#attachBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
    D.attachments.addEventListener('click', e => {
      const x = e.target.closest('[data-attx]');
      if (x) { S.attachments = S.attachments.filter(f => f.id !== x.dataset.attx); renderAttachments(); }
    });
    composerBox.addEventListener('dragover', e => { e.preventDefault(); composerBox.style.borderColor = 'var(--brand)'; });
    composerBox.addEventListener('dragleave', () => { composerBox.style.borderColor = ''; });
    composerBox.addEventListener('drop', e => {
      e.preventDefault();
      composerBox.style.borderColor = '';
      addFiles(e.dataTransfer.files);
    });

    /* voice */
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recog = null, listening = false;
    $('#micBtn').addEventListener('click', () => {
      if (!SR) {
        toast('err', '当前浏览器不支持语音识别', 'Web Speech API 仅在 Chrome/Edge 可用，本 Demo 已做降级处理。');
        return;
      }
      if (listening) { try { recog.stop(); } catch (e) {} return; }
      recog = new SR();
      recog.lang = 'zh-CN';
      recog.interimResults = true;
      recog.continuous = false;
      const before = inputEl.value;
      recog.onstart = () => {
        listening = true;
        $('#micBtn').classList.add('listening');
        $('#micBtn').setAttribute('aria-pressed', 'true');
        toast('info', '正在聆听…', '说出你的问题，完成后自动填入输入框。');
      };
      recog.onresult = ev => {
        let txt = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
        inputEl.value = (before ? before + ' ' : '') + txt;
        autoGrow(); updateComposerState();
      };
      recog.onerror = () => {
        listening = false;
        $('#micBtn').classList.remove('listening');
        $('#micBtn').setAttribute('aria-pressed', 'false');
        toast('err', '语音识别不可用', '可能是麦克风权限或离线环境。已保留文字输入。');
      };
      recog.onend = () => {
        listening = false;
        $('#micBtn').classList.remove('listening');
        $('#micBtn').setAttribute('aria-pressed', 'false');
      };
      try { recog.start(); } catch (e) { toast('err', '无法启动语音', '请重试。'); }
    });

    /* context toggle + popover */
    const syncToggle = () => {
      const t = $('#contextToggle');
      t.setAttribute('aria-pressed', String(!!store.prefs.context));
      t.title = store.prefs.context ? '自动注入当前页面上下文' : '上下文注入已关闭';
    };
    $('#contextToggle').addEventListener('click', () => {
      store.prefs.context = !store.prefs.context;
      syncToggle(); renderContextList(); save();
      toast(store.prefs.context ? 'ok' : 'warn', store.prefs.context ? '已开启上下文注入' : '已关闭上下文注入',
        store.prefs.context ? 'Agent 可读取当前页面与选中内容。' : 'Agent 将只依据对话内容回答。');
    });
    syncToggle();

    function toggleCtx(open) {
      const isOpen = open == null ? D.ctxPop.hidden : open;
      D.ctxPop.hidden = !isOpen;
      $('#ctxPill').setAttribute('aria-expanded', String(isOpen));
      if (isOpen) { renderContextList(); }
    }
    $('#ctxBtn').addEventListener('click', e => { e.stopPropagation(); toggleCtx(); });
    $('#ctxPill').addEventListener('click', e => { e.stopPropagation(); toggleCtx(); });
    $('#ctxRefresh').addEventListener('click', () => {
      renderContextList();
      toast('ok', '已重新采集上下文', 'DOM 摘要、选中文本与身份信息已更新。');
    });
    document.addEventListener('click', e => {
      if (!D.ctxPop.hidden && !e.target.closest('#ctxPop') && !e.target.closest('#ctxPill') && !e.target.closest('#ctxBtn')) toggleCtx(false);
    });

    /* header buttons */
    $('#minimizeBtn').addEventListener('click', () => closePanel());
    $('#closeBtn').addEventListener('click', () => closePanel());
    $('#newChatBtn').addEventListener('click', () => { newSession(); toast('ok', '已新建对话'); });
    $('#historyBtn').addEventListener('click', () => { modalReturn = document.activeElement; openModal('historyModal'); });
    $('#settingsBtn').addEventListener('click', () => { modalReturn = document.activeElement; openModal('settingsModal'); });
    $('#pipExpand').addEventListener('click', () => setMode('float'));
    $('#historyModal').addEventListener('click', e => {
      if (e.target.closest('[data-close-modal]')) closeModal('historyModal');
    });

    /* thread delegation */
    D.thread.addEventListener('click', e => {
      const t = e.target.closest('[data-suggest]');
      if (t) {
        const label = t.dataset.suggest;
        const act = S.messages.reduce((found, m) => found ||
          (m.actions || []).find(a => a.label === label && a.host), null);
        if (act) {
          const ok = hostFlash(act.host);
          if (ok) toast('ok', '已在页面上定位', 'Agent 操作了宿主页面，而不是在对话里描述。');
          else toast('warn', '页面操作已关闭', '可在设置里开启「允许 Agent 操作页面」。');
          return;
        }
        sendMessage(label);
        return;
      }
      const st = e.target.closest('[data-starter]');
      if (st) { sendMessage(st.dataset.q); return; }
      const toolToggle = e.target.closest('[data-tool-toggle]');
      if (toolToggle) {
        const tool = toolToggle.closest('.tool');
        const open = tool.dataset.open !== 'true';
        tool.dataset.open = String(open);
        toolToggle.setAttribute('aria-expanded', String(open));
        const body = tool.querySelector('.tool-body');
        if (body) body.hidden = !open;
        return;
      }
      const copyCode = e.target.closest('[data-copy-code]');
      if (copyCode) {
        const code = copyCode.closest('.code-block').querySelector('code');
        copyText(code ? code.textContent : '');
        return;
      }
      const ap = e.target.closest('[data-approve]');
      if (ap) { decideApproval(ap.dataset.approve, 'approved', readApprovalForm(ap.dataset.approve)); return; }
      const rj = e.target.closest('[data-reject]');
      if (rj) { decideApproval(rj.dataset.reject, 'rejected'); return; }
      const ed = e.target.closest('[data-approve-edit]');
      if (ed) {
        const card = ed.closest('.approval');
        const form = card.querySelector('.form-grid');
        if (form) {
          form.querySelectorAll('input, select').forEach(f => { f.disabled = false; });
          const first = form.querySelector('input, select');
          if (first) first.focus();
          ed.textContent = '已进入编辑';
          ed.disabled = true;
          toast('info', '可以修改参数', '调整后点击「批准并继续」，将按新参数执行。');
        }
        return;
      }
      const a = e.target.closest('[data-a]');
      if (a) {
        handleMessageAction(a.dataset.a, a.dataset.id);
        return;
      }
    });

    /* jump to bottom */
    D.jumpBtn.addEventListener('click', () => scrollBottom(true));
    D.thread.addEventListener('scroll', updateJump, { passive: true });

    /* composer state after resize */
    window.addEventListener('resize', debounce(() => {
      if (store.mode === 'closed') {
        if (!isMobile()) positionLauncher(store.geo.corner); else initLauncherPos();
        return;
      }
      if (isMobile()) {
        agentEl.style.setProperty('--sheet-h', Math.round(store.sheetH * 100) + 'vh');
        agentEl.style.height = '';
      } else {
        const g = geometryFor(store.mode);
        agentEl.style.setProperty('--agent-w', g.w + 'px');
        agentEl.style.setProperty('--agent-h', g.h + 'px');
        agentEl.style.setProperty('--float-left', g.left + 'px');
        agentEl.style.setProperty('--float-top', g.top + 'px');
        agentEl.style.setProperty('--float-right', 'auto');
      }
    }, 140));

    /* queue */
    $('#queueClear').addEventListener('click', () => { S.queue = []; renderQueue(); toast('ok', '已清空队列'); });
    D.queueList.addEventListener('click', e => {
      const x = e.target.closest('[data-qdel]');
      if (x) { S.queue = S.queue.filter(q => q.id !== x.dataset.qdel); renderQueue(); }
    });

    /* history modal */
    D.sessionList.addEventListener('click', e => {
      const del = e.target.closest('[data-del-session]');
      if (del) { e.stopPropagation(); deleteSession(del.dataset.delSession); return; }
      const item = e.target.closest('[data-session]');
      if (item) loadSession(item.dataset.session);
    });
    D.sessionList.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-session]')) {
        e.preventDefault(); loadSession(e.target.closest('[data-session]').dataset.session);
      }
    });
    $('#modalNewChat').addEventListener('click', () => { newSession(); closeModal('historyModal'); });
    $('#clearAllBtn').addEventListener('click', () => {
      if (!window.confirm('确定清空全部历史对话？此操作不可撤销。')) return;
      store.sessions = [];
      newSession({ silent: true });
      renderThread(true); renderSessionList(); save();
      closeModal('historyModal');
      toast('ok', '历史已清空');
    });
    $('#exportBtn').addEventListener('click', () => {
      const data = JSON.stringify(store.sessions, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'nova-copilot-sessions.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('ok', '已导出 JSON', store.sessions.length + ' 个会话');
    });

    /* settings */
    const bindPref = (id, key, after) => {
      const el = document.getElementById(id);
      el.checked = !!store.prefs[key];
      el.addEventListener('change', () => {
        store.prefs[key] = el.checked;
        save();
        if (after) after();
      });
    };
    bindPref('setContext', 'context', () => { renderContextList(); $('#contextToggle').setAttribute('aria-pressed', String(store.prefs.context)); });
    bindPref('setHostActions', 'hostActions');
    bindPref('setAutoScroll', 'autoScroll');
    bindPref('setReduceMotion', 'reduceMotion', applyMotion);
    const speedSel = $('#setSpeed');
    speedSel.value = String(store.prefs.speed);
    speedSel.addEventListener('change', () => { store.prefs.speed = Number(speedSel.value) || 1; save(); });
    $('#resetBtn').addEventListener('click', () => {
      if (!window.confirm('重置窗口状态与本地数据？')) return;
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      location.reload();
    });

    /* backdrop */
    D.backdrop.addEventListener('click', () => closePanel());

    /* demo bar */
    $('#demoToggle').addEventListener('click', () => {
      const open = D.demoPanel.hidden;
      D.demoPanel.hidden = !open;
      $('#demoToggle').setAttribute('aria-expanded', String(open));
    });
    function toggleDemo(open) {
      D.demoPanel.hidden = !open;
      $('#demoToggle').setAttribute('aria-expanded', String(open));
    }
    D.demoPanel.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.scenario) {
        const map = {
          analyze: '分析一下 W36 以来收入下滑的原因，并给出可执行动作',
          approval: '帮我生成本周增长周报，并发布到 #growth-weekly',
          chart: '用图表对比近 12 周的收入和激活率',
          diff: '给我看一下埋点口径修复的代码 diff',
          form: '帮我新建一个华东区 Q4 拉新的投放计划',
          long: '把当前页面的所有指标、告警和渠道数据整理成一份完整复盘',
        };
        openPanel(store.mode === 'closed' ? 'float' : store.mode);
        setTimeout(() => sendMessage(map[b.dataset.scenario]), 260);
        toggleDemo(false);
        return;
      }
      if (b.dataset.debug === 'layers') { toggleLayers(); return; }
      if (b.dataset.debug === 'reset') {
        try { localStorage.removeItem(STORE_KEY); } catch (e) {}
        location.reload();
      }
    });

    /* demo-mode mobile viewport */
    applyDevice();
  }

  function initLauncherPos() {
    launcherEl.style.left = 'auto'; launcherEl.style.top = 'auto';
    launcherEl.style.right = '14px'; launcherEl.style.bottom = '14px';
  }

  /* layers debug */
  let layersEl = null;
  function toggleLayers() {
    if (layersEl) { layersEl.remove(); layersEl = null; toast('ok', '已关闭层级可视化'); return; }
    layersEl = document.createElement('div');
    layersEl.className = 'layer-tags';
    const tags = [
      ['page content · z 0', '92%'],
      ['dock · z 40', '74%'],
      ['fab · z 60', '56%'],
      ['agent · z 80', '38%'],
      ['toast · z 120', '20%'],
      ['modal · z 200', '4%'],
    ];
    tags.forEach(([t, top]) => {
      const d = document.createElement('div');
      d.className = 'layer-tag';
      d.style.top = top;
      d.textContent = t;
      layersEl.appendChild(d);
    });
    document.body.appendChild(layersEl);
    toast('info', '层级可视化已开启', '数值越大越靠上；悬浮窗低于 Toast 与 Modal。');
  }

  function handleMessageAction(action, id) {
    const m = findMsg(id);
    if (!m) return;
    if (action === 'copy') {
      const txt = m.role === 'assistant' ? stripMarkdown(m) : (m.text || '');
      copyText(txt);
      return;
    }
    if (action === 'edit') {
      inputEl.value = m.text || '';
      autoGrow();
      updateComposerState();
      inputEl.focus();
      toast('info', '已载入输入框', '修改后按 Enter 重新发送。');
      return;
    }
    if (action === 'regen') {
      if (S.busy) { toast('warn', '请先停止当前生成'); return; }
      const idx = S.messages.indexOf(m);
      let prev = null;
      for (let i = idx - 1; i >= 0; i--) { if (S.messages[i].role === 'user') { prev = S.messages[i]; break; } }
      S.messages.splice(idx, 1);
      renderThread();
      if (prev) setTimeout(() => sendMessage(prev.text), 200);
      return;
    }
    if (action === 'up' || action === 'down') {
      m.feedback = m.feedback === action ? null : action;
      renderThread();
      save();
      if (m.feedback) toast('ok', '感谢反馈', '已记录，用于优化后续回答。');
      return;
    }
    if (action === 'read') {
      if (!window.speechSynthesis) { toast('err', '浏览器不支持朗读'); return; }
      if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); toast('ok', '已停止朗读'); return; }
      const u = new SpeechSynthesisUtterance(stripMarkdown(m).slice(0, 600));
      u.lang = 'zh-CN';
      u.rate = 1.02;
      window.speechSynthesis.speak(u);
      toast('info', '开始朗读', '再次点击可停止。');
      return;
    }
    if (action === 'del') {
      const idx = S.messages.indexOf(m);
      if (idx >= 0) { S.messages.splice(idx, 1); renderThread(); save(); toast('ok', '已删除消息'); }
      return;
    }
  }

  function stripMarkdown(m) {
    let s = m.text || '';
    (m.blocks || []).forEach(b => {
      if (b.type === 'textSeg' && b.text) s += '\n' + b.text;
      if (b.type === 'approval') s += '\n[审批] ' + b.title + ' — ' + (b.decision || '待审批');
      if (b.type === 'rich' && b.kind === 'metrics') s += '\n' + b.items.map(i => i.label + ' ' + i.value + (i.unit || '')).join('；');
      if (b.type === 'rich' && b.kind === 'timeline') s += '\n' + b.items.map(i => i.title).join(' → ');
    });
    return s.replace(/[#>*`|]/g, ' ').replace(/\n{2,}/g, '\n').trim();
  }

  function copyText(text) {
    const done = () => toast('ok', '已复制到剪贴板');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('err', '复制失败'); }
    ta.remove();
  }

  function stopGeneration() {
    DBG('stop', { busy: S.busy });
    if (!S.busy) return;
    if (S.abort) S.abort.abort();
    if (S.stream) S.stream.stopped = true;
    if (S.approved) { const a = S.approved; S.approved = null; a.resolve(null); }
    S.busy = false;
    updateComposerState();
    updateSub('<i class="live-dot"></i>已停止生成');
    toast('warn', '已中断生成', '保留已生成的内容，可重新生成。');
    const last = S.messages[S.messages.length - 1];
    if (last && last.role === 'assistant' && (last.status === 'streaming' || last.status === 'paused')) {
      last.status = 'stopped';
      renderThread();
    }
    save();
    // a manual stop parks the queue; the user can clear or drain it deliberately
    renderQueue();
  }

  /* ==========================================================
     10 boot
     ========================================================== */
  function greeting() {
    const c = collectContext();
    const m = {
      id: uid('m'), role: 'assistant', ts: Date.now(), status: 'done', followups: [], text: '', blocks: [{ type: 'textSeg', live: false, done: true, text: [
        '我在。已经读过**' + c.title + '**：' + c.kpiHint + '。',
        '注意到一个信号：**收入环比 −8.4%**，但激活率是 **+2.1pt** —— 典型的「获客在改善、变现出问题」。',
        '我可以先去数仓做一次归因，也可以直接给你一版可执行的挽回动作。要从哪边开始？'
      ].join('\n\n') }],
      actions: [{ label: '开始归因', host: '#kpi-revenue' }],
    };
    m.followups = ['先归因收入', '直接给动作清单', '看看企业版流失', '帮我生成周报'];
    appendMessage(m);
    setTimeout(() => toast('info', '按 Ctrl/⌘ + J 可随时唤起', '悬浮球会吸附到最近的屏幕角落。'), 900);
  }

  function boot() {
    applyTheme();
    applyMotion();
    applyDevice();
    html.dataset.mode = store.mode === 'closed' ? 'closed' : store.mode;
    if (isMobile()) initLauncherPos(); else positionLauncher(store.geo.corner || 'br');

    if (store.mode === 'closed') {
      agentEl.hidden = true;
      launcherEl.hidden = false;
      launcherEl.dataset.state = 'closed';
    } else {
      agentEl.dataset.mode = store.mode;
      launcherEl.hidden = true;
      agentEl.classList.add('open');
      agentEl.hidden = false;
      // geometry without toast
      setMode(store.mode, { boot: true });
    }

    ensureMessages();
    renderThread(true);
    renderContextList();
    renderQueue();
    renderSessionList();
    renderAttachments();
    updateComposerState();
    autoGrow();
    wire();
    initLauncher();
    initPanelDrag();
    initResize();
    initSheet();

    const qs = new URLSearchParams(location.search);
    const qt = qs.get('theme');
    if (qt === 'light' || qt === 'dark') {
      store.theme = qt;
      applyTheme();
    } else if (!hadSavedState && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      // first visit: respect the OS preference; afterwards the saved choice wins
      store.theme = 'dark';
      applyTheme();
    }
    if (qs.get('device') === 'mobile') { store.device = 'mobile'; applyDevice(); }
    if (qs.get('mode')) {
      const md = qs.get('mode');
      if (['dock', 'float', 'pip', 'full', 'closed'].includes(md)) setMode(md);
    } else if (!store.mode || store.mode === 'closed') {
      setTimeout(() => { setMode('float', {}); }, 700);
    }
    if (qs.get('prompt')) {
      setTimeout(() => sendMessage(qs.get('prompt')), 1200);
    }
    if (qs.get('scenario') === '1') {
      setTimeout(() => toast('info', 'Demo 提示', '右下角 ⚗ Demo 面板可切换形态与场景。'), 2200);
    }
    if (!store.greeted && qs.get('greet') !== '0') {
      store.greeted = true;
      setTimeout(() => {
        if (!S.messages.length) greeting();
        save();
      }, 1100);
    }
    if (isMobile()) {
      store.sheetH = store.sheetH || 0.66;
      agentEl.style.setProperty('--sheet-h', Math.round(store.sheetH * 100) + 'vh');
    }
    // initial autoscroll
    setTimeout(() => scrollBottom(false), 400);
    updateSub('<i class="live-dot"></i>在线 · 上下文已注入');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // demo/debug hook (read-only snapshot; not part of the product surface)
  window.__nova = {
    dbg: () => DBGLOG.slice(),
    snapshot() {
      return {
        mode: store.mode, busy: S.busy, queue: S.queue.map(q => q.text),
        msgs: S.messages.map(m => ({ role: m.role, status: m.status, chars: (m.text || '').length, blocks: (m.blocks || []).length })),
        input: inputEl.value, sessions: store.sessions.length,
        prefs: store.prefs, geo: store.geo,
      };
    },
  };
})();
