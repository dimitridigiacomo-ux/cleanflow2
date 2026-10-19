#!/usr/bin/env node
// Deploy-time JSX precompile for index.html.
//
// The browser today downloads Babel standalone and translates the one
// <script type="text/babel"> on every page load. This does the same translation
// once, at deploy, with the SAME Babel version (pinned in package-lock.json, it
// must match the CDN tag in index.html) and the SAME options Babel standalone
// uses for a plain text/babel script tag. The source index.html in the repo is
// never changed: only the copy that GitHub Pages publishes.
//
//   node tools/build/precompile.js <in.html> <out.html>               deploy build
//   node tools/build/precompile.js <in.html> <out.html> --browser-equal
//        same options as the browser, inline source map included: the output
//        script must equal, byte for byte, what Babel standalone produces in the page.
//
// Fails (exit 1, nothing written) if anything is not exactly as expected.
'use strict';
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const Babel = require('@babel/standalone');

const [inPath, outPath, flag] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: precompile.js <in.html> <out.html> [--browser-equal]'); process.exit(1); }
const browserEqual = flag === '--browser-equal';
const fail = msg => { console.error('PRECOMPILE FAILED: ' + msg); process.exit(1); };

const html = fs.readFileSync(inPath, 'utf8');

// 1) The Babel CDN tag must name the version we compile with.
const cdnRe = /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/([\d.]+)\/babel\.min\.js"><\/script>/g;
const cdn = [...html.matchAll(cdnRe)];
if (cdn.length !== 1) fail(`expected 1 babel-standalone CDN tag, found ${cdn.length}`);
if (cdn[0][1] !== Babel.version) fail(`index.html loads Babel ${cdn[0][1]} but the build has ${Babel.version}: update tools/build/package.json`);

// 2) Exactly one text/babel script, with no attributes Babel standalone would read.
const OPEN = '<script type="text/babel">', CLOSE = '</script>';
if (html.split('<script type="text/babel"').length !== 2) fail('expected exactly 1 <script type="text/babel"');
const a = html.indexOf(OPEN);
if (a < 0) fail('text/babel script has unexpected attributes');
const b = html.indexOf(CLOSE, a + OPEN.length);
if (b < 0) fail('unterminated text/babel script');

// The page's script.innerHTML: the HTML parser turns CRLF and lone CR into LF.
const source = html.slice(a + OPEN.length, b).replace(/\r\n?/g, '\n');

// 3) Babel standalone's options for an inline, attribute-less text/babel script
//    (see buildBabelOptions/transformCode in @babel/standalone 7.23.2).
const opts = {
  filename: 'Inline Babel script',
  presets: ['react', 'env'],
  plugins: ['transform-class-properties', 'transform-object-rest-spread', 'transform-flow-strip-types'],
  sourceMaps: browserEqual ? 'inline' : false,
  sourceFileName: 'Inline Babel script',
};
let code;
try { code = Babel.transform(source, opts).code; } catch (e) { fail('Babel: ' + e.message); }

// 4) The result must be valid script and safe to inline in HTML.
try { new vm.Script(code, { filename: 'precompiled.js' }); } catch (e) { fail('output does not parse: ' + e.message); }
if (/<\/script/i.test(code)) fail('output contains "</script"');
if (code.includes('<!--')) fail('output contains "<!--"');

// 5) Replace the text/babel script with the compiled one and drop the Babel CDN tag.
let out = html.slice(0, a) + '<script>' + code + html.slice(b);
out = out.replace(cdn[0][0], '');
if (out.includes('text/babel') || out.includes('babel-standalone')) fail('Babel references left in output');

fs.writeFileSync(outPath, out);
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
console.log(JSON.stringify({ babel: Babel.version, mode: browserEqual ? 'browser-equal' : 'deploy',
  inBytes: Buffer.byteLength(html), outBytes: Buffer.byteLength(out), codeChars: code.length, codeSha256: sha(code) }));
