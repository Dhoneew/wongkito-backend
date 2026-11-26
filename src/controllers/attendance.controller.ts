import type { Request, Response } from 'express';
import { isUniqueViolation, query, withTransaction } from '../db.js';
import { isOwner, sessionOf } from '../middleware/auth.middleware.js';
import { ROLE_LABEL, roleFromLoginId } from '../utils/access.js';
import { HttpError, optionalDate, param, readBody, requireNumber, requireOneOf, requireString } from '../utils/http.js';
import type {
  AttendanceCorrection,
  AttendanceListResponse,
  AttendancePagination,
  AttendanceRecord,
  AttendanceSnapshot,
  AttendanceStatus,
  AttendanceSummary,
  AttendanceSummaryResponse,
} from '../utils/types.js';

// Staff attendance: one row per person per day (Asia/Jakarta), with check-in and check-out time.
// Kasir see and record their own attendance; the Owner sees everyone's and may correct with an audit trail.

// Minutes after the shift start before a check-in counts as "Terlambat".
const LATE_GRACE_MINUTES = 15;
const DEFAULT_RANGE_DAYS = 30;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
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

const ATTENDANCE_FROM = `
    FROM attendance t
    JOIN staff_accounts a ON a.login_id = t.login_id`;

const SELECT_ATTENDANCE = `
  SELECT t.id, t.login_id, a.name AS staff_name, a.avatar_url,
         to_char(t.work_date, 'YYYY-MM-DD') AS work_date,
         to_char(t.check_in AT TIME ZONE 'Asia/Jakarta', 'HH24:MI') AS check_in,
         to_char(t.check_out AT TIME ZONE 'Asia/Jakarta', 'HH24:MI') AS check_out,
         round(extract(epoch FROM (t.check_out - t.check_in)) / 60)::int AS duration_minutes,
         t.status
  ${ATTENDANCE_FROM}`;

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

interface AttendanceFilters {
  from: string | null;
  to: string | null;
  employee: string | null;
  status: AttendanceStatus | null;
}

const paginationValue = (value: unknown, label: string, fallback: number, max: number): number =>
  value === undefined || value === '' ? fallback : requireNumber(value, label, { min: 1, max });

// Escape LIKE wildcards so a typed % or _ is treated as part of the keyword.
const likePattern = (value: string): string => `%${value.replace(/[\\%_]/g, '\\$&')}%`;

const readAttendanceFilters = (req: Request, session: ReturnType<typeof sessionOf>): AttendanceFilters => {
  const from = optionalDate(req.query.from, 'Tanggal awal');
  const to = optionalDate(req.query.to, 'Tanggal akhir');
  if (from && to && from > to) {
    throw new HttpError(400, 'Tanggal awal tidak boleh setelah tanggal akhir.');
  }

  const hasEmployee = req.query.employee !== undefined && req.query.employee !== '';
  const hasStatus = req.query.status !== undefined && req.query.status !== '';
  if (!isOwner(session) && (hasEmployee || hasStatus)) {
    throw new HttpError(403, 'Filter karyawan dan status hanya tersedia untuk Owner.');
  }

  return {
    from,
    to,
    employee: hasEmployee ? requireString(req.query.employee, 'Karyawan', { min: 1, max: 100 }) : null,
    status: hasStatus ? requireOneOf(req.query.status, ATTENDANCE_STATUSES, 'Status') : null,
  };
};

// Shared by the paginated list and the summary count so both use identical filters.
const whereFor = (
  session: ReturnType<typeof sessionOf>,
  filters: AttendanceFilters
): { where: string; params: unknown[] } => {
  const params: unknown[] = [filters.from, filters.to, DEFAULT_RANGE_DAYS];
  let where = `WHERE t.work_date >= COALESCE($1::date, (now() AT TIME ZONE 'Asia/Jakarta')::date - $3::int)
                 AND t.work_date <= COALESCE($2::date, (now() AT TIME ZONE 'Asia/Jakarta')::date)`;

  // Kasir is always restricted to their own rows; query params cannot widen this.
  if (!isOwner(session)) {
    params.push(session.account.login_id);
    where += ` AND t.login_id = $${params.length}`;
  }
  if (filters.employee) {
    params.push(likePattern(filters.employee));
    where += ` AND (a.name ILIKE $${params.length} ESCAPE E'\\\\' OR t.login_id ILIKE $${params.length} ESCAPE E'\\\\')`;
  }
  if (filters.status) {
    params.push(filters.status);
    where += ` AND t.status = $${params.length}`;
  }

  return { where, params };
};

// GET /api/attendance?from=&to=&page=1&limit=10&employee=&status= — default: last 30 days, 10 rows.
export const listAttendance = async (req: Request, res: Response) => {
  const session = sessionOf(res);
  const filters = readAttendanceFilters(req, session);
  const page = paginationValue(req.query.page, 'Halaman', DEFAULT_PAGE, 1_000_000_000);
  const limit = paginationValue(req.query.limit, 'Limit per halaman', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const { where, params } = whereFor(session, filters);

  const { rows: countRows } = await query<{ total: number }>(
    `SELECT COUNT(*)::int AS total ${ATTENDANCE_FROM} ${where}`,
    params
  );
  const total = countRows[0]?.total ?? 0;

  const offset = (page - 1) * limit;
  const dataParams = [...params, limit, offset];
  const { rows } = await query<AttendanceRow>(
    `${SELECT_ATTENDANCE} ${where}
      ORDER BY t.work_date DESC, t.check_in DESC, t.id DESC
      LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const pagination: AttendancePagination = { page, limit, total, totalPages: Math.ceil(total / limit) };
  const response: AttendanceListResponse = { attendance: rows.map(toRecord), pagination };
  res.json(response);
};

// GET /api/attendance/summary — full filtered counts, never derived from a page slice.
export const attendanceSummary = async (req: Request, res: Response) => {
  const session = sessionOf(res);
  const filters = readAttendanceFilters(req, session);
  const { where, params } = whereFor(session, filters);

  const { rows } = await query<AttendanceSummary>(
    `SELECT COUNT(*) FILTER (WHERE t.status = 'Hadir')::int AS hadir,
            COUNT(*) FILTER (WHERE t.status = 'Terlambat')::int AS terlambat,
            COUNT(*)::int AS total
       ${ATTENDANCE_FROM} ${where}`,
    params
  );

  const response: AttendanceSummaryResponse = {
    summary: { hadir: rows[0]?.hadir ?? 0, terlambat: rows[0]?.terlambat ?? 0, total: rows[0]?.total ?? 0 },
  };
  res.json(response);
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
