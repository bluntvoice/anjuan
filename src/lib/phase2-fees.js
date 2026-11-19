import { db, audit } from '../db.js';
import { identityError } from './identity-service.js';
import { assertCaseWriteActor, requireVersion } from './phase2-access.js';
import { fenToYuanString, parseMoneyToFen, parsePercentToBps } from './settlement.js';

const PAYMENT_STATES = new Set(['unpaid', 'paid']);
const FEE_ROWS = `SELECT f.id, f.case_id, f.version, f.status, f.note, f.amount_fen,
  t.agreed_fen, t.payable_bps, t.payable_fen FROM fee_items f LEFT JOIN phase2_fee_terms t ON t.fee_id=f.id`;

function feeView(row) {
  const legacy = row.agreed_fen === null;
  return {
    id: row.id,
    case_id: row.case_id,
    version: row.version,
    agreed_amount: legacy ? null : fenToYuanString(row.agreed_fen),
    payable_percent: legacy ? null : fenToYuanString(row.payable_bps),
    payable_amount: legacy ? null : fenToYuanString(row.payable_fen),
    status: row.status,
    note: row.note,
    legacy,
    recorded_amount: legacy && row.amount_fen !== null ? fenToYuanString(row.amount_fen) : null,
  };
}

export function listCaseFees(caseId) {
  const rows = db.prepare(FEE_ROWS + ' WHERE f.case_id=? ORDER BY f.id DESC').all(caseId);
  const totals = { unpaid: 0n, paid: 0n };
  let legacyCount = 0;
  for (const row of rows) {
    if (row.agreed_fen === null) legacyCount += 1;
    else totals[row.status] += BigInt(row.payable_fen);
  }
  return {
    items: rows.map(feeView),
    totals: { unpaid_fen: String(totals.unpaid), paid_fen: String(totals.paid), legacy_count: legacyCount },
  };
}

export function saveCaseFee(caseId, feeId, input, actor) {
  assertCaseWriteActor(actor, true);
  const existing = feeId === null ? null : db.prepare(FEE_ROWS + ' WHERE f.case_id=? AND f.id=?').get(caseId, feeId);
  if (feeId !== null && !existing) throw identityError(404, 'fee_not_found', '律师费记录不存在');
  if (existing?.agreed_fen === null) throw identityError(409, 'legacy_fee_read_only', '历史律师费仅供查阅');
  if (existing) requireVersion(input.version, existing);
  if (!PAYMENT_STATES.has(input.status)) throw identityError(400, 'fee_status_invalid', '付款状态不正确');
  let agreedFen, payableBps;
  try {
    agreedFen = parseMoneyToFen(input.agreed_amount);
    payableBps = parsePercentToBps(input.payable_percent);
    if (agreedFen < 0) throw new RangeError('约定金额须为非负数');
  } catch (error) {
    throw identityError(400, 'fee_amount_invalid', error.message);
  }
  const note = input.note ?? '';
  let id;
  if (existing) {
    id = existing.id;
    db.prepare('UPDATE phase2_fee_terms SET agreed_fen=?,payable_bps=? WHERE fee_id=?').run(agreedFen, payableBps, id);
    db.prepare('UPDATE fee_items SET status=?,note=?,version=version+1 WHERE id=? AND case_id=?')
      .run(input.status, note, id, caseId);
  } else {
    // The legacy REAL amount projection cannot represent every cent. New terms own this amount.
    id = db.prepare(`INSERT INTO fee_items(case_id,label,status,note)
      VALUES(?,'律师费',?,?)`).run(caseId, input.status, note).lastInsertRowid;
    db.prepare('INSERT INTO phase2_fee_terms(fee_id,agreed_fen,payable_bps) VALUES(?,?,?)').run(id, agreedFen, payableBps);
  }
  audit(actor, existing ? 'update' : 'create', 'simple-fee', id, '');
  return feeView(db.prepare(FEE_ROWS + ' WHERE f.id=?').get(id));
}
