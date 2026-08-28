#!/usr/bin/env node
/*
 * CL25Converter 検証スクリプト（依存パッケージなし）
 *
 *   node test/verify.js
 *
 * 黄金テスト: 雛形 CL251G78 を 1→2 変換した結果が雛形 CL252G78 と
 * バイト完全一致（CRLF含む）すること。逆方向も同様。
 * さらに全雛形の往復一致、ガード（部分一致・コメント・途中のM5行など）を確認する。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var C = require('../converter.js');

var SAMPLES = path.join(__dirname, '..', 'samples');
function read(name) { return fs.readFileSync(path.join(SAMPLES, name), 'utf8'); }

var g78_1 = read('CL251G78PP24.04.18.txt');
var g78_2 = read('CL252G78PP24.04.19.txt');
var m22_1 = read('CL251M22X1.5PP24.04.18.txt');
var m18_2 = read('CL252M18X1.5PP24.04.19.txt');

var pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  NG  ' + name + (detail ? '\n      → ' + detail : '')); }
}
function firstDiff(a, b) {
  var n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      var s = i - 25 > 0 ? i - 25 : 0;
      return '位置 ' + i + ': ' + JSON.stringify(a.slice(s, i + 25)) + ' ≠ ' + JSON.stringify(b.slice(s, i + 25));
    }
  }
  return '長さ ' + a.length + ' / ' + b.length;
}
function count(text, re) { var m = text.match(re); return m ? m.length : 0; }

console.log('== 黄金テスト（雛形との完全一致） ==');
var r12 = C.convert(g78_1, '1to2');
check('CL251G78 →(1to2)→ CL252G78 とバイト一致', r12.text === g78_2, r12.text === g78_2 ? '' : firstDiff(r12.text, g78_2));
check('CL251G78 1to2 変換で警告なし', r12.warnings.length === 0, r12.warnings.join(' / '));

var r21 = C.convert(g78_2, '2to1');
check('CL252G78 →(2to1)→ CL251G78 とバイト一致', r21.text === g78_1, r21.text === g78_1 ? '' : firstDiff(r21.text, g78_1));
check('CL252G78 2to1 変換で警告なし', r21.warnings.length === 0, r21.warnings.join(' / '));

console.log('== 置換件数（G7/8 雛形の既知差分数） ==');
var expect12 = {
  'M50→M51': 12, 'M55→M59': 11, 'M8→M458': 7, 'M9→M459': 7, 'M61→M53': 1,
  'T0101→T0101M19': 1, 'T0200→T0200M19': 1, '(CL25-1)→(CL25-2)': 1, '終端M3S1/M5挿入': 1
};
Object.keys(expect12).forEach(function (k) {
  check('1to2 counts[' + k + '] = ' + expect12[k], r12.counts[k] === expect12[k], '実際: ' + r12.counts[k]);
});
var expect21 = {
  'M51→M50': 12, 'M59→M55': 11, 'M458→M8': 7, 'M459→M9': 7, 'M53→M61': 1,
  'M19→削除': 2, '(CL25-2)→(CL25-1)': 1, '終端M3S1/M5削除': 1
};
Object.keys(expect21).forEach(function (k) {
  check('2to1 counts[' + k + '] = ' + expect21[k], r21.counts[k] === expect21[k], '実際: ' + r21.counts[k]);
});

console.log('== 往復テスト（変換→逆変換で原文と完全一致） ==');
[['CL251G78', g78_1, '1to2'], ['CL252G78', g78_2, '2to1'],
 ['CL251M22', m22_1, '1to2'], ['CL252M18', m18_2, '2to1']].forEach(function (t) {
  var name = t[0], src = t[1], dir = t[2];
  var once = C.convert(src, dir);
  var back = C.convert(once.text, C.reverse(dir));
  check(name + ' 往復一致', back.text === src, firstDiff(back.text, src));
});

console.log('== ガードテスト ==');
// (M99P100) は M9 ルールに部分一致させない・コメント内も不変更
check('(M99P100) が両方向で不変更',
  r12.text.indexOf('(M99P100)') >= 0 && r21.text.indexOf('(M99P100)') >= 0);
check('コメント外の M99 も不変更（数字境界ガード）',
  C.convert('M99P100\r\n', '1to2').text === 'M99P100\r\n');
// 途中の単独 M5 行（N6 区間）は 2to1 で削除されない（終端の1行のみ削除）
check('2to1: 単独 M5 行は途中の1行だけ残る（入力2箇所→出力1箇所）',
  count(g78_2, /\r\nM5\r\n/g) === 2 && count(r21.text, /\r\nM5\r\n/g) === 1);
// 終端パターン外では行を削除しない
var noEnd = C.convert('G40\r\nM5\r\nG0T0101M19\r\n', '2to1');
check('終端パターン以外の M5 行は削除されない', noEnd.text === 'G40\r\nM5\r\nG0T0101\r\n');
check('終端パターンが無い場合は警告が出る', noEnd.warnings.length > 0);
// 逆方向を誤って選んだ場合: 置換対象が無く原文のまま＋警告
var wrong = C.convert(g78_2, '1to2');
check('CL252G78 に 1to2 を誤適用しても本文は不変更', wrong.text === g78_2, firstDiff(wrong.text, g78_2));
check('誤方向の適用で警告が出る', wrong.warnings.length > 0, JSON.stringify(wrong.warnings));
// 小文字は変換しない（警告のみ）
var lower = C.convert('m8\r\nM8\r\n', '1to2');
check('小文字 m8 は不変更・大文字 M8 のみ変換', lower.text === 'm8\r\nM458\r\n');
check('小文字検出の警告が出る', lower.warnings.join(' ').indexOf('小文字') >= 0);

console.log('== M22/M18 雛形（別部品）: 設備コードの変換確認 ==');
var m22to2 = C.convert(m22_1, '1to2');
check('M22 1to2: CL25-1 固有コードが残らない',
  !/(?:M50|M55|M61|M8|M9)(?![0-9])/.test(m22to2.text.replace(/\([^)]*\)/g, '')));
check('M22 1to2: 終端が T0200M19 / M3S1 / M5 / G28U0W0 になる',
  m22to2.text.indexOf('\r\nT0200M19\r\nM3S1\r\nM5\r\nG28U0W0\r\n') >= 0);
check('M22 1to2: 機械名が (CL-25-2) になる', m22to2.text.indexOf('(CL-25-2)') >= 0);
var m18to1 = C.convert(m18_2, '2to1');
check('M18 2to1: CL25-2 固有コードが残らない',
  !/(?:M458|M459|M51|M59|M53|M19)(?![0-9])/.test(m18to1.text.replace(/\([^)]*\)/g, '')));
check('M18 2to1: 終端が T0200 / G28U0W0 になる',
  m18to1.text.indexOf('\r\nT0200\r\nG28U0W0\r\n') >= 0);

console.log('== 機械判定 ==');
check('CL251G78 → CL25-1（機械名）', (function (d) { return d.machine === 'CL25-1' && d.byName; })(C.detectMachine(g78_1)));
check('CL252G78 → CL25-2（機械名）', (function (d) { return d.machine === 'CL25-2' && d.byName; })(C.detectMachine(g78_2)));
check('CL251M22 → CL25-1（機械名）', C.detectMachine(m22_1).machine === 'CL25-1');
check('CL252M18 → CL25-2（機械名）', C.detectMachine(m18_2).machine === 'CL25-2');
check('機械名コメント無しでもコードから判定（CL25-2）', C.detectMachine('X0.Z30.M51\r\nM458\r\n').machine === 'CL25-2');

console.log('');
console.log('結果: ' + pass + ' 件成功 / ' + fail + ' 件失敗');
process.exit(fail === 0 ? 0 : 1);
