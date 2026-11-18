'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { assertConfigWritePath } = require('../src/lib/windows-data-paths.cjs');
function atomicJson(file, value) {
  assertConfigWritePath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), '.config-' + crypto.randomUUID() + '.tmp');
  if (process.platform === 'win32') {
    require('../src/lib/private-key-file.js').writeWindowsPrivateTempFile(temporary, Buffer.from(JSON.stringify(value, null, 2)));
    try { fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return;
  }
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
module.exports = { atomicJson };
