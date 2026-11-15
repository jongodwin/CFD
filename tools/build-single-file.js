'use strict';
// Bundles index.html + css + js into one self-contained page fragment (no external files
// except web fonts). Usage: node tools/build-single-file.js <output.html>
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');
const between = (a, b) => html.split(a)[1].split(b)[0];
const head = between('<!--HEAD-->', '<!--/HEAD-->').replace(/<link rel="stylesheet" href="css\/style.css">\n?/, '');
// the spreadsheet library is loaded from a CDN instead of being inlined
const CDN = { 'js/vendor/exceljs.min.js': 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js' };
const body = between('<!--BODY-->', '<!--/BODY-->').replace(/<script src="(js\/vendor\/[^"]+)"><\/script>/g, (_, f) => `<script src="${CDN[f]}"></script>`).replace(/<script src="(js\/[^"]+)"><\/script>/g, (_, f) => `<script>\n${read(f)}</script>`);
fs.writeFileSync(process.argv[2], `${head.trim()}\n<style>\n${read('css/style.css')}</style>\n${body}`);
