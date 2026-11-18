'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveRunRoot } = require('./w0-sqlite-probe.cjs');
const root = path.resolve(__dirname, '../..');
const runRoot = resolveRunRoot();
const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
const template = JSON.parse(fs.readFileSync(path.join(root, 'build/w0-windows.json'), 'utf8'));
const config = { ...source, ...template,
  directories: { ...source.directories, output: path.join(runRoot, 'package-output') },
  electronDist: path.join(root, 'node_modules/electron/dist'),
  extraResources: source.extraResources.filter(resource => resource.from !== 'build/bin/anqi-ocr'),
};
assert(fs.existsSync(path.join(config.electronDist, 'electron.exe')), 'Install the locked Electron binary first');
assert.equal(source.extraResources.length - config.extraResources.length, 1, 'Only the macOS OCR helper is excluded');
const target = path.join(runRoot, 'w0-windows.json');
assert(!fs.existsSync(target), 'Do not overwrite a previous W0 configuration');
fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
fs.writeFileSync(path.join(runRoot, 'w0-config-notes.json'), JSON.stringify({
  output: config.directories.output, publish: 'never (CLI required)',
  omitted: [{ source: 'build/bin/anqi-ocr', reason: 'macOS Swift/Vision helper; no Windows OCR in W0' }],
  npmRebuild: 'false after the separately recorded electron:rebuild; actual packaged SQLite loading is still required',
  signing: 'unpacked test artifact only; executable branding/signing not performed',
  sourcePackageUnchanged: true,
}, null, 2) + '\n');
console.log(JSON.stringify({ config: target, output: config.directories.output, excludedMacHelperOnly: true }));
