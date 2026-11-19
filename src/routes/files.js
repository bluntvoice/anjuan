// 案件文件桥：浏览、上传、取流与附件引用。
// 案件夹是唯一文件真相源；数据库只存相对路径，解除引用不删除原件。
// 文件根由 ANJIAN_FILES_ROOT 配置；上传使用 PUT 原始字节流，文件名走 query。
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { db, audit } from '../db.js';
import { caseRead, caseWrite, caseWritePermission } from '../middleware/phase2-http.js';
import { handled } from './auth.js';
import { identityError } from '../lib/identity-service.js';
import { caseDirectoryKey, validCaseRelativePath, validCasePathSegment } from '../lib/phase2-file-names.js';
import {
  legalRagBridgeConfigured,
  legalRagStateMap,
  queueCaseFile,
} from '../lib/legalrag-bridge.js';
import {
  caseDirectoryName,
  inspectSecureDirectory,
  listSecureDirectory,
  normalizeRelativeFilePath,
  openSecureFile,
  removeSecureCreatedFile,
  resolveCaseDirectoryForCase,
  SecurePathError,
  sanitizeUploadFileName,
  writeUniqueSecureFile,
} from '../lib/secure-files.js';

const ROOT = process.env.ANJIAN_FILES_ROOT || '';

// 允许写入的子目录白名单（§9.3 物理归档维度；上传默认落 法院文书/）
const WRITE_DIRS = ['法院文书', '立案材料', '证据整理', '客户沟通', '办案过程', '人工终稿', '财务凭证'];
const MAX_UPLOAD = 60 * 1024 * 1024; // 60MB
const PHASE2_DIRS = WRITE_DIRS.filter(name => name !== '财务凭证');
const ENTITIES = Object.freeze({ event: 'events', deadline: 'deadlines', fee: 'fee_items', worklog: 'worklog' });

function allowedRelativePath(relative, { allowEmpty = false } = {}) {
  if (relative === '' && allowEmpty) return true;
  return validCaseRelativePath(relative) && caseDirectoryKey(relative.split('/')[0]) !== caseDirectoryKey('财务凭证');
}

function phase2Target(caseId, entity, rawId) {
  if (!entity && rawId === undefined) return ['', null];
  if (typeof entity !== 'string' || !Object.hasOwn(ENTITIES, entity) ||
      !['number', 'string'].includes(typeof rawId) || !/^\d+$/u.test(String(rawId)) ||
      !Number.isSafeInteger(Number(rawId)) || Number(rawId) < 1) {
    throw identityError(400, 'attachment_target_invalid', '附件关联不正确');
  }
  const id = Number(rawId);
  const found = db.prepare(`SELECT 1 FROM ${ENTITIES[entity]} WHERE case_id=? AND id=?`).get(caseId, id);
  if (!found) throw identityError(404, 'attachment_target_missing', '本案没有该关联记录');
  return [entity, id];
}

function checkCanonicalPath(context, relative, absolute) {
  const realRelative = path.relative(context.caseRoot, absolute).split(path.sep).join('/');
  if (caseDirectoryKey(realRelative) !== caseDirectoryKey(relative) ||
      !allowedRelativePath(realRelative, { allowEmpty: true })) {
    throw new SecurePathError('invalid_path', '文件路径名称不正确');
  }
}

function openCaseFile(context, relative, phase2) {
  if (phase2 && !allowedRelativePath(relative)) throw new SecurePathError('invalid_path', '文件路径不正确');
  const opened = openSecureFile(context, relative);
  if (!phase2) return opened;
  try {
    checkCanonicalPath(context, opened.relativePath, opened.absolute);
    if (opened.stat.nlink !== 1) throw new SecurePathError('invalid_path', '文件链接数不正确');
    return opened;
  } catch (error) {
    fs.closeSync(opened.fd);
    throw error;
  }
}

const PATH_BOUNDARY_ERRORS = new Set([
  'not_found',
  'path_changed',
  'invalid_case_name',
  'invalid_path',
  'symlink',
  'escape',
  'not_directory',
  'not_file',
]);

function securePathFailure(
  res,
  error,
  notFoundMessage = '文件或目录不存在',
  { concealPathBoundary = false } = {}
) {
  if (['root_unconfigured', 'root_unavailable', 'root_invalid'].includes(error?.code)) {
    return res.status(503).json({ error: error.message });
  }
  if (error?.code === 'not_found' || (concealPathBoundary && PATH_BOUNDARY_ERRORS.has(error?.code))) {
    return res.status(404).json({ error: notFoundMessage });
  }
  if (error?.code === 'path_changed') return res.status(409).json({ error: error.message });
  if (['invalid_case_name', 'invalid_path', 'invalid_filename', 'symlink', 'escape', 'not_directory', 'not_file'].includes(error?.code)) {
    return res.status(400).json({ error: error.message });
  }
  throw error;
}

// Keep the original handle open until the reference transaction finishes.
function verifyAttachmentFile(context, opened) {
  let current;
  try {
    current = openCaseFile(context, opened.relativePath, true);
  } catch (error) {
    if (!PATH_BOUNDARY_ERRORS.has(error.code)) throw error;
    throw new SecurePathError('path_changed', '附件文件在登记期间发生变化，请重试', error);
  }
  try {
    const originalId = fs.fstatSync(opened.fd, { bigint: true });
    const currentId = fs.fstatSync(current.fd, { bigint: true });
    if (originalId.dev !== currentId.dev || originalId.ino !== currentId.ino || currentId.nlink !== 1n) {
      throw new SecurePathError('path_changed', '附件文件在登记期间发生变化，请重试');
    }
  } finally {
    fs.closeSync(current.fd);
  }
}

// 返回案件行和经过真实路径、目录类型及符号链接检查的案件夹上下文。
function mustCase(req, res, phase2 = false) {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(req.params.id);
  if (!c) { res.status(404).json({ error: '案件不存在' }); return null; }
  try {
    if (phase2 && (!validCasePathSegment(caseDirectoryName(c)) ||
        (c.folder_path && !validCasePathSegment(c.folder_path)))) {
      throw new SecurePathError('invalid_case_name', '案件夹名称不正确');
    }
    const context = resolveCaseDirectoryForCase(ROOT, c);
    if (phase2 && context.exists) {
      const effectiveName = caseDirectoryKey(path.basename(context.caseRoot));
      const shared = db.prepare('SELECT id,name,folder_path FROM cases WHERE id<>?').all(c.id)
        .some(row => caseDirectoryKey(caseDirectoryName(row)) === effectiveName ||
          (context.fallbackFrom && caseDirectoryKey(row.name) === effectiveName));
      if (shared || effectiveName !== caseDirectoryKey(context.name)) {
        throw new SecurePathError('invalid_case_name', '案件夹归属不明确');
      }
    }
    return { c, context };
  } catch (error) {
    securePathFailure(res, error, '文件或目录不存在', {
      concealPathBoundary: req.method === 'GET' || req.method === 'HEAD',
    });
    return null;
  }
}

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.html': 'text/plain; charset=utf-8', // html 以纯文本回，防存储型 XSS
};

// 列一层目录（供 GET /files 与目录指纹复用）；符号链接不进入结果。
function listDir(context, rawRelativePath, phase2 = false) {
  const rel = normalizeRelativeFilePath(rawRelativePath, { allowEmpty: true });
  if (!phase2) return { rel, ...listSecureDirectory(context, rel) };
  if (!allowedRelativePath(rel, { allowEmpty: true })) throw new SecurePathError('invalid_path', '目录路径不正确');
  const directory = inspectSecureDirectory(context, rel);
  checkCanonicalPath(context, rel, directory.absolute);
  const listing = listSecureDirectory(context, rel);
  const visible = name => allowedRelativePath(rel ? path.posix.join(rel, name) : name);
  return {
    rel,
    dirs: listing.dirs.filter(visible),
    files: listing.files.filter(file => {
      if (!visible(file.name)) return false;
      try { return fs.lstatSync(path.join(directory.absolute, file.name)).nlink === 1; }
      catch { return false; }
    }),
  };
}

export function createFilesRouter({ phase2 = false } = {}) {
const r = Router();
const read = phase2 ? [caseRead] : [];
const write = phase2 ? [caseWritePermission] : [];
const commit = (req, work) => phase2 ? caseWrite(req, work) : work(req.actor);

// 浏览案件夹（单层；dir 相对案件根）
r.get('/cases/:id/files', ...read, (req, res) => {
  const m = mustCase(req, res, phase2);
  if (!m) return;
  const { context } = m;
  if (!context.exists) return res.json({ exists: false, dir: '', dirs: [], files: [] });
  let listing;
  try {
    listing = listDir(context, String(req.query.dir || ''), phase2);
  } catch (error) {
    return securePathFailure(res, error, '目录不存在', { concealPathBoundary: true });
  }
  if (phase2) return res.json({ exists: true, dir: listing.rel, dirs: listing.dirs, files: listing.files, write_dirs: PHASE2_DIRS,
    ...(context.fallbackNotice ? { workspace_notice: context.fallbackNotice } : {}) });
  const states = legalRagStateMap(m.c.id);
  const files = listing.files.map((file) => {
    const relPath = listing.rel ? path.posix.join(listing.rel, file.name) : file.name;
    const state = states.get(relPath);
    return {
      ...file,
      legalrag: state ? {
        id: state.id,
        status: state.sync_status,
        revision: state.revision,
        document_id: state.legalrag_document_id,
        candidate_count: state.candidate_count,
        document_type: state.document_type,
        case_relation: state.case_relation,
        evidence_mode: state.evidence_mode,
        screening_decision: state.screening_decision,
        screening_reason: state.screening_reason,
        error: state.last_error,
      } : null,
    };
  });
  res.json({
    exists: true, dir: listing.rel, dirs: listing.dirs, files,
    write_dirs: WRITE_DIRS, legalrag_enabled: legalRagBridgeConfigured(),
    // 只读透传：secure-files 判定回落到同名目录时提示前端；正常案件整个省略该字段
    ...(context.fallbackNotice ? { workspace_notice: context.fallbackNotice } : {}),
  });
});

// 取文件流（inline 预览）
r.get('/cases/:id/file', ...read, (req, res) => {
  const m = mustCase(req, res, phase2);
  if (!m) return;
  if (!m.context.exists) return res.status(404).json({ error: '文件不存在' });
  let opened;
  try {
    opened = openCaseFile(m.context, String(req.query.path || ''), phase2);
  } catch (error) {
    return securePathFailure(res, error, '文件不存在', { concealPathBoundary: true });
  }
  const ext = path.extname(opened.absolute).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(opened.absolute))}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'HEAD') {
    fs.closeSync(opened.fd);
    return res.end();
  }
  const stream = fs.createReadStream(opened.absolute, { fd: opened.fd, autoClose: true });
  stream.on('error', error => res.destroy(error));
  res.once('close', () => stream.destroy());
  stream.pipe(res);
});

// 上传（原始字节流）。query: dir(白名单)、name、entity/entity_id（可选，同时建引用）
r.put('/cases/:id/files', ...write, express.raw({ type: '*/*', limit: MAX_UPLOAD, inflate: false }), handled((req, res) => {
  const m = mustCase(req, res, phase2);
  if (!m) return;
  const { c, context } = m;
  const dir = String(req.query.dir || '法院文书');
  const allowed = phase2 ? PHASE2_DIRS : WRITE_DIRS;
  if (!allowed.includes(dir)) return res.status(400).json({ error: `dir 须为：${allowed.join('/')}` });
  const name = sanitizeUploadFileName(req.query.name);
  if (!name || (phase2 && (!validCasePathSegment(req.query.name) || name !== req.query.name))) {
    return res.status(400).json({ error: '文件名非法' });
  }
  if (!req.body || !req.body.length || (phase2 && !Buffer.isBuffer(req.body))) return res.status(400).json({ error: '空文件' });
  if (!context.exists) return res.status(404).json({ error: `案件夹不存在：${c.name}（请先建立或核对案件夹名称）` });

  let written, attachment;
  try {
    attachment = commit(req, actor => {
      const [entity, entityId] = phase2
        ? phase2Target(c.id, req.query.entity, req.query.entity_id)
        : [String(req.query.entity || ''), req.query.entity_id ? Number(req.query.entity_id) : null];
      written = writeUniqueSecureFile(context, dir, name, req.body);
      if (phase2) checkCanonicalPath(context, written.relativePath, written.absolute);
      let row = null;
      if (['event', 'deadline', 'fee', 'worklog', ''].includes(entity)) {
        const info = db.prepare(
          'INSERT INTO attachments (case_id, entity, entity_id, rel_path, filename, size, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(c.id, entity, entityId, written.relativePath, written.filename, req.body.length, 'upload');
        row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid);
      }
      audit(actor, 'upload', 'file', row?.id || null, `${c.name}/${written.relativePath} ${req.body.length}B`);
      return row;
    });
  } catch (error) {
    if (phase2 && written && !removeSecureCreatedFile(context, written)) {
      console.error('Attachment rollback could not remove the created file', { caseId: c.id });
    }
    return securePathFailure(res, error);
  }
  const final = written.filename;
  const relPath = written.relativePath;
  let legalrag = null;
  if (!phase2 && legalRagBridgeConfigured()) {
    try {
      legalrag = queueCaseFile(c.id, relPath, { priority: 90, actor: req.actor });
    } catch (error) {
      legalrag = { status: 'failed', error: error.message };
    }
  }
  res.json({ ok: true, rel_path: relPath, filename: final, attachment, ...(phase2 ? {} : { legalrag }) });
}));

// 把案件夹里已有文件挂到记录上（引用，不复制）
r.post('/cases/:id/attachments', ...write, handled((req, res) => {
  const m = mustCase(req, res, phase2);
  if (!m) return;
  const { c, context } = m;
  const b = req.body || {};
  if (phase2 && (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.rel_path !== 'string' ||
      Object.keys(b).some(key => !['rel_path', 'entity', 'entity_id'].includes(key)))) {
    throw identityError(400, 'fields_invalid', '附件字段不正确');
  }
  if (!context.exists) return res.status(404).json({ error: '文件不存在' });
  let opened, attachment;
  try {
    opened = openCaseFile(context, String(b.rel_path || ''), phase2);
    if (!['event', 'deadline', 'fee', 'worklog', ''].includes(b.entity || '')) return res.status(400).json({ error: 'entity 非法' });
    attachment = commit(req, actor => {
      const [entity, entityId] = phase2 ? phase2Target(c.id, b.entity, b.entity_id) : [b.entity || '', b.entity_id || null];
      const info = db.prepare(
        'INSERT INTO attachments (case_id, entity, entity_id, rel_path, filename, size, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(c.id, entity, entityId, opened.relativePath, path.basename(opened.absolute), opened.stat.size, 'link');
      audit(actor, 'link', 'attachment', info.lastInsertRowid, `${c.name}/${opened.relativePath}`);
      const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(info.lastInsertRowid);
      if (phase2) verifyAttachmentFile(context, opened);
      return row;
    });
  } catch (error) {
    return securePathFailure(res, error, '文件不存在');
  } finally {
    if (opened) fs.closeSync(opened.fd);
  }
  res.status(phase2 ? 201 : 200).json(attachment);
}));

if (phase2) return r;

// ---- 案件夹变更推送（0.6.0）----
// SSE + fs.watch；平台或文件系统不支持 watch 时，前端在页面可见期间轻量轮询目录指纹。
const WATCH_DEBOUNCE = 300;   // 合并同步软件的写入风暴
const SSE_HEARTBEAT = 25000;  // 穿过反向代理的空闲超时

// 递归 watch；平台不支持 recursive 时退化为「根 + 一级子目录」并在变更时补挂新子目录
function watchTree(root, onChange) {
  const watchers = [];
  const watched = new Set();
  const add = (p) => {
    if (watched.has(p)) return;
    try { watchers.push(fs.watch(p, onChange)); watched.add(p); } catch { /* 单个子目录挂不上不致命 */ }
  };
  try {
    watchers.push(fs.watch(root, { recursive: true }, onChange));
    return { watchers, rearm: () => {} };
  } catch {
    add(root);
    const rearm = () => {
      if (!fs.existsSync(root)) return;
      for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) add(path.join(root, ent.name));
      }
    };
    rearm();
    return { watchers, rearm };
  }
}

r.get('/cases/:id/files/events', (req, res) => {
  const m = mustCase(req, res);
  if (!m) return;
  const { context } = m;
  const watchRoot = context.exists ? context.caseRoot : context.filesRoot;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // 提示支持该响应头的反向代理不要缓冲事件流
  });

  let watch = null;
  let timer = null;
  const queue = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      watch?.rearm();
      res.write(`event: change\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    }, WATCH_DEBOUNCE);
  };

  try {
    // 案件夹还没建时盯已解析的文件根——它一出现就能推第一条。
    watch = watchTree(watchRoot, queue);
  } catch {
    res.write('event: degraded\ndata: {"reason":"watch-unavailable"}\n\n');
  }

  res.write(`event: ready\ndata: ${JSON.stringify({ watching: !!watch })}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT);

  req.on('close', () => {
    clearInterval(hb);
    clearTimeout(timer);
    for (const w of watch?.watchers || []) { try { w.close(); } catch { /* 已关 */ } }
    res.end();
  });
});

// 目录指纹（SSE 不可用时的轮询降级路径；一次 readdir，够便宜）
r.get('/cases/:id/files/sig', (req, res) => {
  const m = mustCase(req, res);
  if (!m) return;
  const { context } = m;
  if (!context.exists) return res.json({ exists: false, sig: '' });
  let listing;
  try {
    listing = listDir(context, String(req.query.dir || ''));
  } catch (error) {
    return securePathFailure(res, error, '目录不存在', { concealPathBoundary: true });
  }
  const sig = [
    ...listing.dirs,
    ...listing.files.map((f) => `${f.name}:${f.size}:${Math.round(f.mtime_ms)}`),
  ].join('|');
  res.json({ exists: true, sig });
});

// 解除引用（不动文件本体）
r.delete('/attachments/:aid', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.aid);
  if (!row) return res.status(404).json({ error: '附件引用不存在' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  audit(req.actor, 'unlink', 'attachment', row.id, row.rel_path);
  res.json({ ok: true, note: '仅解除引用，文件本体仍在案件夹' });
});

return r;
}

export default createFilesRouter();
