// Test-owned resource boundary for the four explicitly authorized W04-R scripts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { TestResources } from './test-resources.js';
export class W04RResources extends TestResources {
  constructor(url) { super(url); this.links = new Map(); }
  symlink(target, link) {
    const directory = fs.statSync(target).isDirectory();
    fs.symlinkSync(target, link, directory ? 'dir' : 'file');
    const stat = fs.lstatSync(link);
    assert(stat.isSymbolicLink());
    this.links.set(`${stat.dev}:${stat.ino}`, { directory, target: fs.readlinkSync(link) });
    const query = spawnSync('fsutil.exe', ['reparsepoint', 'query', link], { windowsHide: true });
    assert.equal(query.status, 0); assert(query.stdout.toString('latin1').toLowerCase().includes('a000000c'), 'must be a true native symlink, not junction');
    console.log('W04R_LINK ' + JSON.stringify({ path: link, directory, nativeTag: '0xa000000c' }));
  }
  directory(value) {
    const real = fs.realpathSync.native(value);
    assert.equal(real, path.resolve(value)); assert(!fs.lstatSync(value).isSymbolicLink());
    return this.own(`directory:${value}`, value, () => {
      assert.equal(fs.realpathSync.native(value), real);
      const inspect = dir => {
        for (const entry of fs.readdirSync(dir)) {
          const file = path.join(dir, entry), stat = fs.lstatSync(file);
          if (stat.isSymbolicLink()) {
            const known = this.links.get(`${stat.dev}:${stat.ino}`);
            assert(known, 'refuse to remove an unknown reparse entry');
            assert.equal(fs.readlinkSync(file), known.target);
            if (known.directory && process.platform === 'win32') fs.rmdirSync(file); else fs.unlinkSync(file);
          } else if (stat.isDirectory()) inspect(file);
          else assert.equal(stat.nlink, 1, 'unexpected hard link in test root');
        }
      };
      inspect(value);
      if (process.env.R2_CLEANUP_ARCHIVE) {
        const archive = path.join(process.env.R2_CLEANUP_ARCHIVE, path.basename(value)); fs.mkdirSync(archive, { recursive: true });
        for (const name of fs.readdirSync(value)) if (name.endsWith('.log')) fs.copyFileSync(path.join(value, name), path.join(archive, name));
      }
      fs.rmSync(value, { recursive: true, force: false });
      assert(!fs.existsSync(value)); return { path: value, removed: true, knownLinksUnlinkedWithoutFollowing: true };
    }, 50);
  }
}
