import type { Request, Response } from 'express';
import { isUniqueViolation, query, withTransaction } from '../db.js';
import { isOwner, sessionOf } from '../middleware/auth.middleware.js';
import { ROLE_LABEL, roleFromLoginId } from '../utils/access.js';
import { HttpError, optionalDate, param, readBody, requireOneOf, requireString } from '../utils/http.js';
import type { AttendanceCorrection, AttendanceRecord, AttendanceSnapshot } from '../utils/types.js';

// Staff attendance: one row per person per day (Asia/Jakarta), with check-in and check-out time.
// Kasir see and record their own attendance; the Owner sees everyone's and may correct with an audit trail.

// Minutes after the shift start before a check-in counts as "Terlambat".
const LATE_GRACE_MINUTES = 15;
const DEFAULT_RANGE_DAYS = 30;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ATTENDANCE_STATUSES = ['Hadir', 'Terlambat'] as const;

interface AttendanceRow {
  id: string;
  login_id: string;
  staff_name: string;
  avatar_url: string | null;
  work_date: string;
  check_in: string;
  check_out: string | null;
  duration_minutes: number | null;
  status: AttendanceRecord['status'];
}

interface CorrectionRow {
  id: string;
  attendance_id: string;
  corrected_by: string;
  before_data: AttendanceSnapshot;
  after_data: AttendanceSnapshot;
  reason: string;
  corrected_at: string;
}

const SELECT_ATTENDANCE = `
  SELECT t.id, t.login_id, a.name AS staff_name, a.avatar_url,
         to_char(t.work_date, 'YYYY-MM-DD') AS work_date,
         to_char(t.check_in AT TIME ZONE 'Asia/Jakarta', 'HH24:MI') AS check_in,
         to_char(t.check_out AT TIME ZONE 'Asia/Jakarta', 'HH24:MI') AS check_out,
         round(extract(epoch FROM (t.check_out - t.check_in)) / 60)::int AS duration_minutes,
         t.status
    FROM attendance t
    JOIN staff_accounts a ON a.login_id = t.login_id`;

const toRecord = (row: AttendanceRow): AttendanceRecord => {
  const role = roleFromLoginId(row.login_id);
  return {
    id: row.id,
    loginId: row.login_id,
    staffName: row.staff_name,
    role: role ? ROLE_LABEL[role] : '',
    date: row.work_date,
    checkInTime: row.check_in,
    ...(row.check_out ? { checkOutTime: row.check_out } : {}),
    durationMinutes: row.duration_minutes,
    status: row.status,
    ...(row.avatar_url ? { avatar: row.avatar_url } : {}),
  };
};

const snapshotOf = (row: AttendanceRow): AttendanceSnapshot => ({
  date: row.work_date,
  checkInTime: row.check_in,
  ...(row.check_out ? { checkOutTime: row.check_out } : {}),
  status: row.status,
});

// "Pagi (07.00–15.00)" → 420 (minutes after midnight); null when the shift has no time in it.
const shiftStartMinutes = (shift: string): number | null => {
  const match = /(\d{1,2})[.:](\d{2})/.exec(shift);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

const jakartaMinutesNow = (): number => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date())
    .split(':')
    .map(Number);
  return h * 60 + m;
};

// Correction times are local Jakarta wall-clock values on the record's work_date.
// Asia/Jakarta is fixed UTC+7, so an explicit offset keeps this independent of server TZ.
const parseCorrectionTime = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new HttpError(400, `${label} harus berformat HH:mm (24 jam).`);
  }
  return value;
};

const toJakartaInstant = (workDate: string, time: string): Date => {
  const instant = new Date(`${workDate}T${time}:00+07:00`);
  if (Number.isNaN(instant.getTime())) throw new HttpError(400, 'Tanggal atau waktu koreksi tidak valid.');
  return instant;
};

const requireKasir = (session: ReturnType<typeof sessionOf>): void => {
  if (roleFromLoginId(session.account.login_id) !== 'kasir') {
    throw new HttpError(403, 'Hanya kasir yang boleh melakukan absensi.');
  }
};

// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD — default: the last 30 days.
export const listAttendance = async (req: Request, res: Response) => {
  const session = sessionOf(res);
  const from = optionalDate(req.query.from, 'Tanggal awal');
  const to = optionalDate(req.query.to, 'Tanggal akhir');
  if (from && to && from > to) {
    throw new HttpError(400, 'Tanggal awal tidak boleh setelah tanggal akhir.');
  }

  const params: unknown[] = [from, to, DEFAULT_RANGE_DAYS];
  let where = `WHERE t.work_date >= COALESCE($1::date, (now() AT TIME ZONE 'Asia/Jakarta')::date - $3::int)
                  AND t.work_date <= COALESCE($2::date, (now() AT TIME ZONE 'Asia/Jakarta')::date)`;
  if (!isOwner(session)) {
    params.push(session.account.login_id);
    where += ` AND t.login_id = $${params.length}`;
  }

  const { rows } = await query<AttendanceRow>(`${SELECT_ATTENDANCE} ${where} ORDER BY t.work_date DESC, t.check_in DESC`, params);
  res.json({ attendance: rows.map(toRecord) });
};

// GET /api/attendance/today — own record for today, or null.
export const todayAttendance = async (_req: Request, res: Response) => {
  const { account } = sessionOf(res);
  const { rows } = await query<AttendanceRow>(
    `${SELECT_ATTENDANCE} WHERE t.login_id = $1 AND t.work_date = (now() AT TIME ZONE 'Asia/Jakarta')::date`,
    [account.login_id]
  );
  res.json({ attendance: rows[0] ? toRecord(rows[0]) : null });
};

// POST /api/attendance/check-in — kasir only, once per day. Server sets the time and date.
export const checkIn = async (_req: Request, res: Response) => {
  const session = sessionOf(res);
  requireKasir(session);
  const { account } = session;
  const start = shiftStartMinutes(account.shift);
  const status = start !== null && jakartaMinutesNow() > start + LATE_GRACE_MINUTES ? 'Terlambat' : 'Hadir';

  try {
    const { rows: inserted } = await query<{ id: string }>(
      `INSERT INTO attendance (login_id, work_date, status)
       VALUES ($1, (now() AT TIME ZONE 'Asia/Jakarta')::date, $2)
       RETURNING id`,
      [account.login_id, status]
    );
    const { rows } = await query<AttendanceRow>(`${SELECT_ATTENDANCE} WHERE t.id = $1`, [inserted[0].id]);
    res.status(201).json({ attendance: toRecord(rows[0]) });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, 'Kamu sudah absen masuk hari ini.');
    throw err;
  }
};

// POST /api/attendance/check-out — kasir only, closes today's record. Server sets the time.
export const checkOut = async (_req: Request, res: Response) => {
  const session = sessionOf(res);
  requireKasir(session);
  const { account } = session;
  // Atomic guard: only the first request that still has check_out = NULL may close the record.
  const { rows: closed } = await query<{ id: string }>(
    `UPDATE attendance
        SET check_out = now(), updated_at = now()
      WHERE login_id = $1
        AND work_date = (now() AT TIME ZONE 'Asia/Jakarta')::date
        AND check_out IS NULL
      RETURNING id`,
    [account.login_id]
  );

  // SELECT is only used after a failed update to choose the right 409 message.
  if (!closed[0]) {
    const { rows: current } = await query<{ id: string; check_out: Date | null }>(
      `SELECT id, check_out FROM attendance
        WHERE login_id = $1 AND work_date = (now() AT TIME ZONE 'Asia/Jakarta')::date`,
      [account.login_id]
    );
    if (!current[0]) throw new HttpError(409, 'Kamu belum absen masuk hari ini.');
    throw new HttpError(409, 'Kamu sudah absen pulang hari ini.');
  }

  const { rows } = await query<AttendanceRow>(`${SELECT_ATTENDANCE} WHERE t.id = $1`, [closed[0].id]);
  res.json({ attendance: toRecord(rows[0]) });
};

// PATCH /api/attendance/:id/correct — Owner only. Writes an immutable audit row in the same transaction.
export const correctAttendance = async (req: Request, res: Response) => {
  const session = sessionOf(res);
  if (!isOwner(session)) throw new HttpError(403, 'Hanya Owner yang boleh mengoreksi absensi.');

  const id = param(req, 'id');
  const body = readBody(req);
  const reason = requireString(body.reason, 'Alasan koreksi', { min: 1, max: 500 });

  const hasCheckIn = body.checkInTime !== undefined;
  const hasCheckOut = body.checkOutTime !== undefined;
  const hasStatus = body.status !== undefined;
  if (!hasCheckIn && !hasCheckOut && !hasStatus) {
    throw new HttpError(400, 'Minimal satu data harus dikoreksi.');
  }

  const nextCheckIn = hasCheckIn ? parseCorrectionTime(body.checkInTime, 'Waktu check-in') : null;
  const nextCheckOut = hasCheckOut ? parseCorrectionTime(body.checkOutTime, 'Waktu check-out') : null;
  const nextStatus = hasStatus ? requireOneOf(body.status, ATTENDANCE_STATUSES, 'Status') : null;

  const result = await withTransaction(async (client) => {
    // Lock the attendance row before reading the snapshot so concurrent corrections form one chain.
    const { rows: beforeRows } = await client.query<AttendanceRow>(
      `${SELECT_ATTENDANCE} WHERE t.id = $1 FOR UPDATE OF t`,
      [id]
    );
    const before = beforeRows[0];
    if (!before) throw new HttpError(404, 'Data absensi tidak ditemukan.');

    const checkInTime = nextCheckIn ?? before.check_in;
    const checkOutTime = nextCheckOut ?? before.check_out;
    const status = nextStatus ?? before.status;

    if (checkOutTime && checkOutTime < checkInTime) {
      throw new HttpError(400, 'Waktu check-out tidak boleh lebih awal dari check-in.');
    }
    const checkInAt = toJakartaInstant(before.work_date, checkInTime);
    const checkOutAt = checkOutTime ? toJakartaInstant(before.work_date, checkOutTime) : null;
    if (checkOutAt && checkOutAt < checkInAt) {
      throw new HttpError(400, 'Waktu check-out tidak boleh lebih awal dari check-in.');
    }

    await client.query(
      `UPDATE attendance SET check_in = $2, check_out = $3, status = $4, updated_at = now() WHERE id = $1`,
      [id, checkInAt, checkOutAt, status]
    );

    const { rows: afterRows } = await client.query<AttendanceRow>(`${SELECT_ATTENDANCE} WHERE t.id = $1`, [id]);
    const after = afterRows[0];

    await client.query(
      `INSERT INTO attendance_corrections (attendance_id, corrected_by, before_data, after_data, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        id,
        session.account.login_id,
        JSON.stringify(snapshotOf(before)),
        JSON.stringify(snapshotOf(after)),
        reason,
      ]
    );

    return { attendance: toRecord(after) };
  });

  res.json(result);
};

// GET /api/attendance/:id/corrections — Owner only, read-only audit trail.
export const listCorrections = async (req: Request, res: Response) => {
  const session = sessionOf(res);
  if (!isOwner(session)) throw new HttpError(403, 'Hanya Owner yang boleh melihat riwayat koreksi.');

  const id = param(req, 'id');
  const { rows } = await query<CorrectionRow>(
    `SELECT c.id, c.attendance_id, c.corrected_by, c.before_data, c.after_data, c.reason,
            to_char(c.corrected_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS corrected_at
       FROM attendance_corrections c
      WHERE c.attendance_id = $1
      ORDER BY c.corrected_at DESC`,
    [id]
  );

  const corrections: AttendanceCorrection[] = rows.map((row) => ({
    id: row.id,
    attendanceId: row.attendance_id,
    correctedBy: row.corrected_by,
    before: row.before_data,
    after: row.after_data,
    reason: row.reason,
    correctedAt: row.corrected_at,
  }));
  res.json({ corrections });
};
