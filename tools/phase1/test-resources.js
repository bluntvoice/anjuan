// Test-owned resources only. A cleanup failure never replaces the primary error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function bounded(promise, label, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export class TestResources {
  constructor(url) { this.script = fileURLToPath(url); this.actions = []; }
  own(kind, value, close, phase) {
    this.actions.push({ kind, phase, close });
    return value;
  }
  directory(value) {
    // Only a freshly created fixture directory can be enrolled by callers.
    const real = fs.realpathSync.native(value);
    if (path.resolve(real).toLowerCase() !== path.resolve(value).toLowerCase() || fs.lstatSync(value).isSymbolicLink()) {
      throw new Error(`fixture directory is an alias: ${value}`);
    }
    return this.own(`directory:${value}`, value, () => {
      if (!fs.existsSync(value)) return;
      if (fs.realpathSync.native(value) !== real) throw new Error('fixture directory identity changed');
      // Do not follow a reparse point introduced after enrollment.
      const inspect = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const name = path.join(dir, entry.name);
        if (fs.lstatSync(name).isSymbolicLink()) throw new Error(`unexpected fixture link: ${name}`);
        if (entry.isDirectory()) inspect(name);
      } };
      inspect(value);
      if (process.env.R2_CLEANUP_ARCHIVE) {
        const archive = path.join(process.env.R2_CLEANUP_ARCHIVE, path.basename(value));
        fs.mkdirSync(archive, { recursive: true });
        for (const name of fs.readdirSync(value)) if (name.endsWith('.log') && fs.lstatSync(path.join(value, name)).isFile()) fs.copyFileSync(path.join(value, name), path.join(archive, name));
      }
      fs.rmSync(value, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 });
      if (fs.existsSync(value)) throw new Error('fixture directory remains');
      return { path: value, removed: true };
    }, 50);
  }
  database(db) { return this.own('sqlite', db, () => { if (db.open) db.close(); if (db.open) throw new Error('SQLite remains open'); return { open: db.open }; }, 30); }
  file(fd) { return this.own('log-fd', fd, () => fs.closeSync(fd), 40); }
  server(server) { return this.own('http-server', server, async () => {
    if (!server.listening) return;
    const address = server.address();
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeIdleConnections?.();
    try { await bounded(closed, 'HTTP close'); }
    catch (error) { server.closeAllConnections?.(); await bounded(closed, 'HTTP forced close'); throw error; }
    if (server.listening) throw new Error('HTTP listener remains');
    return { address, listening: server.listening };
  }, 20); }
  child(child) {
    const closed = new Promise(resolve => child.once('close', resolve));
    return this.own(`child:${child.pid}`, child, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try { await bounded(closed, 'child close'); }
    catch (error) { child.kill('SIGKILL'); await bounded(closed, 'child forced close'); throw error; }
    if (child.exitCode === null && child.signalCode === null) throw new Error('child remains alive');
    return { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, closed: true };
  }, 20); }
  stream(reader, controller) { return this.own('SSE reader', reader, async () => {
    controller.abort();
    try { await bounded(reader.cancel(), 'SSE cancel'); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
    reader.releaseLock();
  }, 10); }
  cleanup(label, action, phase = 10) { this.own(label, null, action, phase); }
  link(value) { return this.own(`owned-link:${value}`, value, () => {
    if (!fs.lstatSync(value).isSymbolicLink()) throw new Error('owned test link identity changed');
    fs.unlinkSync(value); // unlink the fixture entry itself, never its target.
  }, 40); }
  async finish(primaryError) {
    const cleanup = [];
    for (const action of this.actions.sort((a, b) => a.phase - b.phase)) {
      try { const details = await bounded(Promise.resolve().then(action.close), action.kind, 12000); cleanup.push({ resource: action.kind, status: 'passed', details }); }
      catch (error) { cleanup.push({ resource: action.kind, status: 'failed', error: String(error) }); }
    }
    const failed = cleanup.filter(row => row.status === 'failed');
    const record = { script: this.script, at: new Date().toISOString(),
      main: primaryError ? { status: 'failed', error: String(primaryError), code: primaryError.code || null } : { status: 'passed' },
      cleanup: { status: failed.length ? 'failed' : 'passed', resources: cleanup } };
    if (process.env.R2_RESOURCE_RESULTS) fs.appendFileSync(process.env.R2_RESOURCE_RESULTS, JSON.stringify(record) + '\n');
    console.log('R2_RESOURCES ' + JSON.stringify(record));
    if (!primaryError && failed.length) throw new AggregateError(failed.map(row => new Error(row.error)), 'test cleanup failed');
  }
}
