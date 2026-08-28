/*
 * CL25Converter — NC旋盤 CL25-1 / CL25-2 プログラム相互変換エンジン
 *
 * 方針:
 *   - 定義済みルールの置換のみを行い、ルール外の文字・改行・空白・コメントは
 *     一切変更しない（機械干渉防止）。
 *   - Mコード等のトークン置換は数字境界ガード付き（M9 が M99 に部分一致しない）。
 *   - コメント ( ) 内には機械名ルール以外を適用しない（例: (M99P100) は不変更）。
 *   - 改行コード（CRLF / LF）は行ごとに元のまま保持する。
 *
 * ブラウザでは window.CL25Converter、Node では module.exports で公開
 * （テストと画面で同一コードを使用するため）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CL25Converter = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  // 変換方向
  //   '1to2' : CL25-1 → CL25-2
  //   '2to1' : CL25-2 → CL25-1
  var MACHINES = {
    '1to2': { from: 'CL25-1', to: 'CL25-2' },
    '2to1': { from: 'CL25-2', to: 'CL25-1' }
  };

  // ------------------------------------------------------------------
  // ルール定義（雛形 G7/8 プログラムの CL25-1 / CL25-2 差分から確定）
  // ------------------------------------------------------------------

  // トークン置換ルール（コメント ( ) 内には適用しない）
  // skipIfFollowedBy: 直後に既にその文字列が続く場合は置換しない（M19 二重付加防止）
  var TOKEN_RULES = {
    '1to2': [
      { find: 'T0101', repl: 'T0101M19', id: 'T0101→T0101M19', skipIfFollowedBy: 'M19' },
      { find: 'T0200', repl: 'T0200M19', id: 'T0200→T0200M19', skipIfFollowedBy: 'M19' },
      { find: 'M50', repl: 'M51', id: 'M50→M51' },
      { find: 'M55', repl: 'M59', id: 'M55→M59' },
      { find: 'M61', repl: 'M53', id: 'M61→M53' },
      { find: 'M8', repl: 'M458', id: 'M8→M458' },
      { find: 'M9', repl: 'M459', id: 'M9→M459' }
    ],
    '2to1': [
      { find: 'M458', repl: 'M8', id: 'M458→M8' },
      { find: 'M459', repl: 'M9', id: 'M459→M9' },
      { find: 'M51', repl: 'M50', id: 'M51→M50' },
      { find: 'M59', repl: 'M55', id: 'M59→M55' },
      { find: 'M53', repl: 'M61', id: 'M53→M61' },
      { find: 'M19', repl: '', id: 'M19→削除' }
    ]
  };

  // 機械名コメント置換（行全体＝コメント内にも適用。CL-25-1 / CL25-1 両表記対応）
  var NAME_RULES = {
    '1to2': { re: /(CL-?25-)1(?![0-9])/g, digit: '2', id: '(CL25-1)→(CL25-2)' },
    '2to1': { re: /(CL-?25-)2(?![0-9])/g, digit: '1', id: '(CL25-2)→(CL25-1)' }
  };

  // 終端ブロック（CL25-2 のみ T0200M19 の直後に M3S1・M5 の2行が存在する）
  var END_BLOCK = ['M3S1', 'M5'];
  var COUNT_END_INSERT = '終端M3S1/M5挿入';
  var COUNT_END_DELETE = '終端M3S1/M5削除';

  // 画面・README 表示用のルール一覧
  var RULE_TABLE = [
    { cl251: '(CL-25-1)', cl252: '(CL-25-2)', kind: '機械名コメント', note: 'CL25-1 / CL-25-1 どちらの表記にも対応' },
    { cl251: 'M50', cl252: 'M51', kind: 'Mコード', note: '' },
    { cl251: 'M55', cl252: 'M59', kind: 'Mコード', note: '' },
    { cl251: 'M8', cl252: 'M458', kind: 'Mコード', note: '' },
    { cl251: 'M9', cl252: 'M459', kind: 'Mコード', note: '' },
    { cl251: 'M61', cl252: 'M53', kind: 'Mコード', note: '' },
    { cl251: 'T0101', cl252: 'T0101M19', kind: 'M19 付加/削除', note: 'CL25-2 側のみ M19 付き' },
    { cl251: 'T0200', cl252: 'T0200M19', kind: 'M19 付加/削除', note: 'CL25-2 側のみ M19 付き' },
    { cl251: '（なし）', cl252: 'M3S1・M5（2行）', kind: '終端ブロック', note: 'T0200M19 直後・G28U0W0 直前の位置のみ挿入/削除' }
  ];

  // ------------------------------------------------------------------
  // 内部ユーティリティ
  // ------------------------------------------------------------------

  function buildTokenRegex(rules) {
    var alts = [];
    for (var i = 0; i < rules.length; i++) alts.push(rules[i].find);
    alts.sort(function (a, b) { return b.length - a.length; }); // 最長一致を優先
    return new RegExp('(' + alts.join('|') + ')(?![0-9])', 'g');
  }

  function buildRuleMap(rules) {
    var map = {};
    for (var i = 0; i < rules.length; i++) map[rules[i].find] = rules[i];
    return map;
  }

  var TOKEN_RE = { '1to2': buildTokenRegex(TOKEN_RULES['1to2']), '2to1': buildTokenRegex(TOKEN_RULES['2to1']) };
  var RULE_MAP = { '1to2': buildRuleMap(TOKEN_RULES['1to2']), '2to1': buildRuleMap(TOKEN_RULES['2to1']) };

  // 設備固有トークンの検出用（判定・警告のみに使用。変換には使わない）
  var TOK1_RE = /(?:M50|M55|M61|M8|M9)(?![0-9])/g;                 // CL25-1 固有
  var TOK2_RE = /(?:M458|M459|M51|M59|M53|M19)(?![0-9])/g;         // CL25-2 固有
  var NAME1_RE = /CL-?25-1(?![0-9])/g;
  var NAME2_RE = /CL-?25-2(?![0-9])/g;
  var LOWER_RE = /(?:m(?:458|459|50|51|55|59|53|61|19|8|9)|t0101|t0200)(?![0-9])/g;

  // テキストを { text, eol, no } の行配列へ分解（改行コードを行ごとに保持）
  function splitLines(text) {
    var parts = String(text).split(/(\r\n|\r|\n)/);
    var lines = [];
    var no = 1;
    for (var i = 0; i < parts.length; i += 2) {
      var content = parts[i];
      var eol = (i + 1 < parts.length) ? parts[i + 1] : '';
      if (i === parts.length - 1 && content === '') break; // 最終改行の後の空要素
      lines.push({ text: content, eol: eol, no: no++ });
    }
    return lines;
  }

  function joinLines(lines) {
    var buf = '';
    for (var i = 0; i < lines.length; i++) buf += lines[i].text + lines[i].eol;
    return buf;
  }

  // 1行をコメント( )内 / 外のセグメントに分解
  function splitCommentSegments(line) {
    var segs = [];
    var buf = '';
    var depth = 0;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (depth === 0) {
        if (ch === '(') {
          if (buf) segs.push({ text: buf, comment: false });
          buf = '(';
          depth = 1;
        } else {
          buf += ch;
        }
      } else {
        buf += ch;
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { segs.push({ text: buf, comment: true }); buf = ''; }
        }
      }
    }
    // 閉じ括弧なしの残り: コメント途中なら保守的にコメント扱い（変換しない）
    if (buf) segs.push({ text: buf, comment: depth > 0 });
    return segs;
  }

  // コメント( )内を除去したテキスト（判定・警告用）
  function stripComments(text) {
    var lines = splitLines(text);
    var buf = [];
    for (var i = 0; i < lines.length; i++) {
      var segs = splitCommentSegments(lines[i].text);
      var t = '';
      for (var s = 0; s < segs.length; s++) if (!segs[s].comment) t += segs[s].text;
      buf.push(t);
    }
    return buf.join('\n');
  }

  function countMatches(text, re) {
    var m = String(text).match(re);
    return m ? m.length : 0;
  }

  function bump(counts, id, n) {
    counts[id] = (counts[id] || 0) + (typeof n === 'number' ? n : 1);
  }

  // ------------------------------------------------------------------
  // 機械判定
  // ------------------------------------------------------------------

  // 機械名コメントを最優先、無ければ設備固有トークンの出現数で推定
  function detectMachine(text) {
    var n1 = countMatches(text, NAME1_RE);
    var n2 = countMatches(text, NAME2_RE);
    var stripped = stripComments(text);
    var t1 = countMatches(stripped, TOK1_RE);
    var t2 = countMatches(stripped, TOK2_RE);

    var machine = null;
    var byName = false;
    if (n1 > 0 && n2 === 0) { machine = 'CL25-1'; byName = true; }
    else if (n2 > 0 && n1 === 0) { machine = 'CL25-2'; byName = true; }
    else if (n1 === 0 && n2 === 0) {
      if (t1 > 0 && t2 === 0) machine = 'CL25-1';
      else if (t2 > 0 && t1 === 0) machine = 'CL25-2';
      else if (t1 > t2) machine = 'CL25-1';
      else if (t2 > t1) machine = 'CL25-2';
    }
    return {
      machine: machine,
      byName: byName,
      names: { cl251: n1, cl252: n2 },
      tokens: { cl251: t1, cl252: t2 },
      mixed: (n1 > 0 && n2 > 0) || (t1 > 0 && t2 > 0)
    };
  }

  // ------------------------------------------------------------------
  // 変換本体
  // ------------------------------------------------------------------

  // トークン置換（コメント外のみ）
  function convertLineTokens(lineText, direction, onApply, onSkip) {
    var segs = splitCommentSegments(lineText);
    var re = TOKEN_RE[direction];
    var map = RULE_MAP[direction];
    var out = '';
    for (var s = 0; s < segs.length; s++) {
      if (segs[s].comment) { out += segs[s].text; continue; }
      out += segs[s].text.replace(re, function (m, tok, offset, whole) {
        var rule = map[tok];
        if (rule.skipIfFollowedBy) {
          var rest = whole.slice(offset + tok.length);
          var f = rule.skipIfFollowedBy;
          if (rest.lastIndexOf(f, 0) === 0 && !/^[0-9]/.test(rest.slice(f.length))) {
            if (onSkip) onSkip(rule);
            return m; // 既に付加済み → 何もしない
          }
        }
        onApply(rule);
        return rule.repl;
      });
    }
    return out;
  }

  // 機械名コメント置換（行全体）
  function convertLineName(lineText, direction, onApply) {
    var nr = NAME_RULES[direction];
    return lineText.replace(nr.re, function (m, p1) {
      onApply(nr);
      return p1 + nr.digit;
    });
  }

  // 1→2: T0200M19 行の直後（次行が G28U0W0 のときのみ）に M3S1・M5 を挿入
  function insertEndBlock(lines, counts, changes, warnings) {
    var inserted = 0;
    for (var i = 0; i < lines.length - 1; i++) {
      if (lines[i].text === 'T0200M19' && lines[i + 1].text === 'G28U0W0') {
        var eol = lines[i].eol;
        lines.splice(i + 1, 0,
          { text: END_BLOCK[0], eol: eol, no: null },
          { text: END_BLOCK[1], eol: eol, no: null });
        changes.push({ type: 'insert', line: lines[i].no, before: null, after: END_BLOCK[0], rules: [COUNT_END_INSERT] });
        changes.push({ type: 'insert', line: lines[i].no, before: null, after: END_BLOCK[1], rules: [COUNT_END_INSERT] });
        bump(counts, COUNT_END_INSERT);
        inserted++;
        i += 2;
      }
    }
    if (inserted === 0) {
      warnings.push('終端パターン（T0200M19 の次行が G28U0W0）が見つからないため、M3S1・M5 の挿入は行いませんでした。終端部を手動で確認してください。');
    }
  }

  // 2→1: T0200 / M3S1 / M5 / G28U0W0 の並びのときのみ M3S1・M5 の2行を削除
  function removeEndBlock(lines, counts, changes, warnings) {
    var removed = 0;
    for (var i = 0; i + 3 < lines.length; i++) {
      if (lines[i].text === 'T0200' &&
          lines[i + 1].text === END_BLOCK[0] &&
          lines[i + 2].text === END_BLOCK[1] &&
          lines[i + 3].text === 'G28U0W0') {
        changes.push({ type: 'delete', line: lines[i + 1].no, before: END_BLOCK[0], after: null, rules: [COUNT_END_DELETE] });
        changes.push({ type: 'delete', line: lines[i + 2].no, before: END_BLOCK[1], after: null, rules: [COUNT_END_DELETE] });
        lines.splice(i + 1, 2);
        bump(counts, COUNT_END_DELETE);
        removed++;
      }
    }
    if (removed === 0) {
      warnings.push('終端の M3S1・M5（T0200M19 直後・G28U0W0 直前）が見つからないため、行削除は行いませんでした。終端部を手動で確認してください。');
    }
  }

  /**
   * NCプログラムを変換する。
   * @param {string} text      入力プログラム全文
   * @param {string} direction '1to2'（CL25-1→CL25-2）または '2to1'（CL25-2→CL25-1）
   * @returns {{ text: string,
   *            changes: Array<{type:string, line:number|null, before:string|null, after:string|null, rules:string[]}>,
   *            counts: Object, warnings: string[], direction: string }}
   */
  function convert(text, direction) {
    if (direction !== '1to2' && direction !== '2to1') {
      throw new Error('direction は "1to2" か "2to1" を指定してください: ' + direction);
    }
    var M = MACHINES[direction];
    var counts = {};
    var changes = [];
    var warnings = [];

    // --- 事前チェック（警告のみ。変換内容には影響しない） ---
    var det = detectMachine(text);
    var stripped = stripComments(text);
    if (det.machine && det.machine !== M.from) {
      warnings.push('入力プログラムは ' + det.machine + ' 用と判定されました。選択中の変換方向（' + M.from + ' → ' + M.to + '）と一致していません。方向を確認してください。');
    } else {
      var oppCount = countMatches(stripped, direction === '1to2' ? TOK2_RE : TOK1_RE);
      if (oppCount > 0) {
        warnings.push('入力に ' + M.to + ' 固有のコードが ' + oppCount + ' 箇所含まれています。ルール対象外のためそのまま残ります。内容を確認してください。');
      }
    }
    var lowerCount = countMatches(stripped, LOWER_RE);
    if (lowerCount > 0) {
      warnings.push('小文字のコード（m8 / m50 等）を ' + lowerCount + ' 箇所検出しました。変換は大文字のみが対象です（小文字は変更されません）。');
    }

    // --- トークン置換＋機械名置換（行単位） ---
    var lines = splitLines(text);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var before = line.text;
      var applied = [];
      var after = convertLineTokens(before, direction,
        function (rule) { applied.push(rule.id); bump(counts, rule.id); },
        function (rule) { warnings.push('行 ' + line.no + ': ' + rule.find + ' には既に M19 が付いているため、二重付加をスキップしました。'); });
      after = convertLineName(after, direction,
        function (rule) { applied.push(rule.id); bump(counts, rule.id); });
      if (after !== before) {
        if (before !== '' && after === '') {
          warnings.push('行 ' + line.no + ': M19 削除により行が空になりました。必要に応じて確認してください。');
        }
        line.text = after;
        changes.push({ type: 'replace', line: line.no, before: before, after: after, rules: applied });
      }
    }

    // --- 終端ブロック（行の挿入/削除。位置パターン一致時のみ） ---
    if (direction === '1to2') insertEndBlock(lines, counts, changes, warnings);
    else removeEndBlock(lines, counts, changes, warnings);

    return {
      text: joinLines(lines),
      changes: changes,
      counts: counts,
      warnings: warnings,
      direction: direction
    };
  }

  function reverse(direction) {
    return direction === '1to2' ? '2to1' : '1to2';
  }

  return {
    VERSION: VERSION,
    MACHINES: MACHINES,
    RULE_TABLE: RULE_TABLE,
    TOKEN_RULES: TOKEN_RULES,
    convert: convert,
    reverse: reverse,
    detectMachine: detectMachine
  };
});
