import { Router } from 'express';
import { db } from '../db.js';
import { todayCN } from '../lib/dates.js';
import { readCaseCalendar, readCaseToday } from '../lib/case-dashboard.js';
import { identityError } from '../lib/identity-service.js';
import { listCaseFees, saveCaseFee } from '../lib/phase2-fees.js';
import { caseFields, caseId, caseRead, writeCaseRoute, caseWritePermission } from '../middleware/phase2-http.js';
import { handled } from './auth.js';
import { upsertContactRecord } from './contacts.js';
import { createFactRecord, updateFactRecord } from './legalrag.js';

const r = Router();
const CONTACT_FIELDS = ['role', 'name', 'phone', 'id_no', 'org', 'note'];
const FACT_FIELDS = ['content', 'occurred_on', 'source', 'note'];
const FEE_FIELDS = ['agreed_amount', 'payable_percent', 'status', 'note'];

function existingCase(rawId) {
  const id = caseId(rawId);
  if (!db.prepare('SELECT 1 FROM cases WHERE id=?').get(id)) {
    throw identityError(404, 'case_not_found', '案件不存在');
  }
  return id;
}

r.get('/cases/:id/contacts', caseRead, handled((req, res) => {
  res.json(db.prepare('SELECT * FROM contacts WHERE case_id=? ORDER BY id').all(existingCase(req.params.id)));
}));
r.post('/cases/:id/contacts', caseWritePermission, writeCaseRoute((req, actor) => {
  const payload = caseFields(req.body, CONTACT_FIELDS);
  return upsertContactRecord({ caseId: existingCase(req.params.id), payload, actor, phase2: true }).row;
}));
r.patch('/cases/:id/contacts/:recordId', caseWritePermission, writeCaseRoute((req, actor) => {
  const payload = caseFields(req.body, [...CONTACT_FIELDS, 'version'], ['version']);
  return upsertContactRecord({
    caseId: existingCase(req.params.id), payload: { ...payload, id: caseId(req.params.recordId) }, actor, phase2: true,
  }).row;
}));

r.get('/cases/:id/facts', caseRead, handled((req, res) => {
  res.json(db.prepare(`SELECT * FROM facts WHERE case_id=?
    ORDER BY COALESCE(NULLIF(occurred_on,''),'9999-12-31') DESC,id DESC`).all(existingCase(req.params.id)));
}));
r.post('/cases/:id/facts', caseWritePermission, writeCaseRoute((req, actor) => {
  const payload = caseFields(req.body, FACT_FIELDS);
  return createFactRecord({ caseId: existingCase(req.params.id), payload, actor, phase2: true });
}));
r.patch('/cases/:id/facts/:recordId', caseWritePermission, writeCaseRoute((req, actor) => {
  const payload = caseFields(req.body, [...FACT_FIELDS, 'version'], ['version']);
  return updateFactRecord({
    caseId: existingCase(req.params.id), factId: caseId(req.params.recordId), payload, actor, phase2: true,
  });
}));

r.get('/cases/:id/fees', caseRead, handled((req, res) => {
  res.json(listCaseFees(existingCase(req.params.id)));
}));
r.post('/cases/:id/fees', caseWritePermission, writeCaseRoute((req, actor) => {
  return saveCaseFee(existingCase(req.params.id), null, caseFields(req.body, FEE_FIELDS), actor);
}));
r.patch('/cases/:id/fees/:recordId', caseWritePermission, writeCaseRoute((req, actor) => {
  const input = caseFields(req.body, [...FEE_FIELDS, 'version'], ['version']);
  return saveCaseFee(existingCase(req.params.id), caseId(req.params.recordId), input, actor);
}));

r.get('/cases/:id/audit', caseRead, handled((req, res) => {
  if (req.user.role_key !== 'admin') throw identityError(403, 'audit_forbidden', '仅管理员可查看案件审计');
  const id = existingCase(req.params.id);
  const limit = 100;
  const before = req.query.before === undefined ? null : caseId(req.query.before);
  // Historical audit rows have no case_id. Resolve ownership only through the
  // matching table, and exclude earlier lifetimes when a row ID was reused.
  const rows = db.prepare(`WITH retired AS (
    SELECT entity, entity_id, MAX(id) AS last_id
    FROM audit_log
    WHERE action='delete' OR (entity='attachment' AND action='unlink')
    GROUP BY entity, entity_id
  )
  SELECT a.id,a.at,a.actor,a.action,a.entity,a.entity_id
    FROM audit_log a
    LEFT JOIN events e ON a.entity='event' AND e.id=a.entity_id
    LEFT JOIN deadlines d ON a.entity='deadline' AND d.id=a.entity_id
    LEFT JOIN tasks t ON a.entity='task' AND t.id=a.entity_id
    LEFT JOIN contacts c ON a.entity='contact' AND c.id=a.entity_id
    LEFT JOIN facts f ON a.entity='fact' AND f.id=a.entity_id
    LEFT JOIN fee_items fee ON a.entity IN ('fee','simple-fee') AND fee.id=a.entity_id
    LEFT JOIN attachments att
      ON (a.entity='attachment' OR (a.entity='file' AND a.action='upload')) AND att.id=a.entity_id
    LEFT JOIN worklog w ON a.entity='worklog' AND w.id=a.entity_id
    LEFT JOIN retired r ON r.entity_id=a.entity_id AND r.entity=CASE a.entity
      WHEN 'file' THEN 'attachment' WHEN 'simple-fee' THEN 'fee' ELSE a.entity END
    WHERE (@before IS NULL OR a.id < @before) AND a.id > COALESCE(r.last_id,0) AND (
      (a.entity='case' AND a.entity_id=@caseId)
      OR @caseId IN (e.case_id,d.case_id,t.case_id,c.case_id,f.case_id,fee.case_id,att.case_id,w.case_id)
    ) ORDER BY a.id DESC LIMIT @limit`).all({ before, caseId: id, limit: limit + 1 });
  res.json({ items: rows.slice(0, limit), next_before: rows.length > limit ? rows[limit - 1].id : null });
}));

r.get('/case-dashboard/today', caseRead, handled((_req, res) => res.json(readCaseToday())));
r.get('/case-dashboard/calendar', caseRead, handled((req, res) => {
  const month = req.query.month ?? todayCN().slice(0, 7);
  if (typeof month !== 'string' || !/^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/u.test(month)) {
    throw identityError(400, 'month_invalid', '月份须为 YYYY-MM');
  }
  res.json(readCaseCalendar(month));
}));

export default r;
