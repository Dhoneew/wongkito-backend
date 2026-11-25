import { Router } from 'express';
import { getPublicStoreInfo, getSettings, updateSettings } from '../controllers/settings.controller.js';
import { requireOwner, requireSession } from '../middleware/auth.middleware.js';

// /api/settings — everyone logged in reads them (receipts, POS tax); only the Owner changes them.
// /api/settings/public is open: name, tagline, address, phone and opening hours only.
const router = Router();

router.get('/public', getPublicStoreInfo);
router.get('/', requireSession, getSettings);
router.put('/', requireOwner('Hanya Owner yang boleh mengubah pengaturan toko.'), updateSettings);

export default router;
