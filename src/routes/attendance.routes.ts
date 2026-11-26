import { Router } from 'express';
import {
  attendanceSummary,
  checkIn,
  checkOut,
  correctAttendance,
  listAttendance,
  listCorrections,
  todayAttendance,
} from '../controllers/attendance.controller.js';
import { requireOwner, requireSession } from '../middleware/auth.middleware.js';

// /api/attendance — kasir see and record their own attendance, the Owner sees everyone's.
// Owner-only correction and audit-log routes are added without changing the existing contract.
const router = Router();

router.use(requireSession);
router.get('/', listAttendance);
router.get('/summary', attendanceSummary);
router.get('/today', todayAttendance);
router.post('/check-in', checkIn);
router.post('/check-out', checkOut);
// Literal routes stay before /:id routes.
router.get('/:id/corrections', requireOwner('Hanya Owner yang boleh melihat riwayat koreksi.'), listCorrections);
router.patch('/:id/correct', requireOwner('Hanya Owner yang boleh mengoreksi absensi.'), correctAttendance);

export default router;
