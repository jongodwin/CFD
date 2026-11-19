#!/usr/bin/env node
/*
 * Bundle index.html and its scripts into one self-contained HTML file.
 *   node tools/build-standalone.js                 -> dist/rotary-kiln-simulator.html
 *   node tools/build-standalone.js out.html        -> custom path
 *   node tools/build-standalone.js out.html --fragment
 *        writes the page without <html>/<head>/<body> wrappers, for hosts that add their own.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const fragment = args.includes('--fragment');
const out = args.find(a => !a.startsWith('--')) || path.join(root, 'dist', 'rotary-kiln-simulator.html');

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  const code = fs.readFileSync(path.join(root, src), 'utf8').replace(/<\/script/gi, '<\\/script');
  return '<script>\n' + code + '\n</script>';
});

if (fragment) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1]
    .replace(/<meta charset[^>]*>\s*/i, '')
    .replace(/<meta name="viewport"[^>]*>\s*/i, '');
  const body = /<body>([\s\S]*?)<\/body>/.exec(html)[1];
  html = head.trim() + '\n' + body.trim() + '\n';
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log('Wrote ' + out + ' (' + (html.length / 1024).toFixed(0) + ' kB)');
