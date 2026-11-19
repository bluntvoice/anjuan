import { db } from '../db.js';
import { addDays, diffDays, todayCN } from './dates.js';

const deadlines = 'd.id, d.case_id, c.name AS case_name, d.name, d.due_on, d.severity, d.status, d.basis, d.calc_note, d.rolled_from';
const hearings = 'e.id, e.case_id, c.name AS case_name, e.occurred_on, e.occurred_time, e.location';
const tasks = 't.id, t.case_id, c.name AS case_name, t.title, t.plan_date, t.due_on, t.due_time, t.status, t.priority, t.note';

export function readCaseToday() {
  const date = todayCN();
  const d3 = addDays(date, 3);
  const d7 = addDays(date, 7);
  const moving = db.prepare('SELECT ' + deadlines + ' FROM deadlines d JOIN cases c ON c.id=d.case_id '
    + "WHERE d.status='pending' AND d.review_status='confirmed' AND d.advisory=0 AND c.status='active' "
    + "AND d.due_on<>'' AND d.due_on<=? ORDER BY d.due_on, d.severity='critical' DESC, d.id")
    .all(addDays(date, 30)).map(row => ({ ...row, days_left: diffDays(date, row.due_on) }));
  const opening = db.prepare('SELECT ' + hearings + ' FROM events e JOIN cases c ON c.id=e.case_id '
    + "WHERE e.type='hearing' AND c.status='active' AND e.occurred_on BETWEEN ? AND ? "
    + "ORDER BY e.occurred_on, e.occurred_time='', e.occurred_time, e.id")
    .all(date, d7).map(row => ({ ...row, is_today: row.occurred_on === date }));
  const openTasks = db.prepare('SELECT ' + tasks + ' FROM tasks t JOIN cases c ON c.id=t.case_id '
    + "WHERE t.status='open' ORDER BY COALESCE(NULLIF(t.due_on,''),NULLIF(t.plan_date,''),'9999-12-31'), "
    + "t.priority='high' DESC,t.id").all();
  const todayTasks = [];
  const weekTasks = [];
  for (const task of openTasks) {
    if ((task.plan_date && task.plan_date <= date) || (task.due_on && task.due_on <= d3)) {
      todayTasks.push(task);
    } else {
      const effective = task.due_on || task.plan_date;
      if (effective && effective <= d7) weekTasks.push(task);
    }
  }
  todayTasks.sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high'));
  const gaps = db.prepare("SELECT c.id,c.name AS case_name,c.procedure,c.stage FROM cases c WHERE c.status='active' "
    + "AND NOT EXISTS (SELECT 1 FROM deadlines d WHERE d.case_id=c.id AND d.status='pending' "
    + "AND d.review_status='confirmed' AND d.advisory=0) "
    + "AND NOT EXISTS (SELECT 1 FROM events e WHERE e.case_id=c.id AND e.type='hearing' AND e.occurred_on>=?) "
    + 'ORDER BY c.updated_at,c.id').all(date);
  return {
    date,
    counts: {
      active_cases: db.prepare("SELECT count(*) AS count FROM cases WHERE status='active'").get().count,
      open_tasks: openTasks.length,
    },
    red: moving.filter(row => row.due_on <= d3),
    week: moving.filter(row => row.due_on > d3 && row.due_on <= d7),
    watch: moving.filter(row => row.due_on > d7),
    hearings: opening,
    today_tasks: todayTasks,
    week_tasks: weekTasks,
    all_tasks: openTasks,
    no_deadline_cases: gaps,
  };
}

export function readCaseCalendar(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = month + '-01';
  const last = month + '-' + new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const days = db.prepare('SELECT date,kind FROM holidays WHERE date BETWEEN ? AND ?').all(first, last);
  return {
    month,
    holidays: Object.fromEntries(days.map(day => [day.date, day.kind])),
    deadlines: db.prepare('SELECT ' + deadlines + ' FROM deadlines d JOIN cases c ON c.id=d.case_id '
      + 'WHERE d.advisory=0 AND d.due_on BETWEEN ? AND ? ORDER BY d.due_on,d.id').all(first, last),
    hearings: db.prepare('SELECT ' + hearings + ' FROM events e JOIN cases c ON c.id=e.case_id '
      + "WHERE e.type='hearing' AND e.occurred_on BETWEEN ? AND ? "
      + "ORDER BY e.occurred_on,e.occurred_time='',e.occurred_time,e.id").all(first, last),
    tasks: db.prepare('SELECT ' + tasks + ' FROM tasks t JOIN cases c ON c.id=t.case_id '
      + "WHERE t.due_on BETWEEN ? AND ? OR (t.plan_date<>'' AND t.plan_date<=? AND t.due_on>=?) "
      + "ORDER BY t.due_on,t.due_time='',t.due_time,t.id").all(first, last, last, first),
    unplanned_tasks: db.prepare('SELECT ' + tasks + ' FROM tasks t JOIN cases c ON c.id=t.case_id '
      + "WHERE t.status='open' AND t.due_on='' ORDER BY t.priority='high' DESC,t.id").all(),
  };
}
