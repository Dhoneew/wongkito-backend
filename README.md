# Backend Warkop Wong Kito

Backend API untuk sistem manajemen Warkop Wong Kito (WKM). Service ini melayani autentikasi staf, pengelolaan menu dan stok, transaksi POS, akun kasir, absensi, pengaturan toko, notifikasi, serta ringkasan dashboard. Frontend Warkop Wong Kito memanggil endpoint di bawah prefix `/api`.

> Implementasi saat ini memakai PostgreSQL, sesi berbasis cookie `httpOnly`, dan hash password `scrypt`. Backend ini tidak memakai MySQL, JWT, atau bcrypt.

## Teknologi

| Area | Implementasi sesuai kode |
| --- | --- |
| Runtime | Node.js dengan ESM (`"type": "module"`), target TypeScript ES2022 dan resolusi `nodenext` |
| Bahasa | TypeScript `^7.0.2`, mode `strict`, tanpa emit (`tsc --noEmit`) |
| HTTP | Express `^5.3.0`, `cookie-parser` `^1.4.7`, `cors` `^2.8.6` |
| Database | PostgreSQL melalui `pg` `^8.23.1` |
| Password | `scrypt` bawaan `node:crypto`, format `scrypt$N$r$p$salt$hash` |
| Sesi | Token acak di cookie `wk_session`; hanya hash SHA-256 yang disimpan di tabel `staff_sessions` |
| Keamanan | Cookie `httpOnly`, `SameSite=Lax`, `Secure` saat `NODE_ENV=production`; CORS dan pemeriksaan `Origin` untuk request tulis |
| Tooling | `tsx` `^4.23.15` untuk menjalankan TypeScript, `@types/*` untuk tipe Node/Express/pg |
| Logging | Log terstruktur per request dengan header `X-Request-Id`; folder `logs/` dibuat saat runtime |

## Fitur yang tersedia

- **Authentication & session**: login/logout, profil akun, ganti password, sesi tersimpan di database dan dapat dicabut.
- **Role-based access control**: role diturunkan dari prefix login ID (`OWN-` = Owner/`superadmin`, `KSR-` = Kasir), bukan dipilih saat login.
- **Menu management**: Owner mengelola menu; kasir hanya melihat menu yang tersedia.
- **Stock/inventory**: Owner mengelola stok bahan baku; staf login dapat melihatnya.
- **Orders/POS**: checkout menghitung harga, pajak, dan kembalian di server serta mengurangi stok menu dalam transaksi; status pesanan dapat diubah, pembatalan hanya oleh Owner.
- **Team/staff**: Owner membuat, mengubah, menonaktifkan kasir, dan mereset password kasir.
- **Attendance**: check-in/check-out kasir, lihat absensi, koreksi Owner, dan riwayat koreksi/audit trail.
- **Dashboard & ringkasan**: penjualan hari ini, per jam, 7 hari terakhir, dan menu terlaris. Belum ada endpoint laporan terpisah.
- **Settings**: pengaturan toko untuk nota/POS dan endpoint publik berisi informasi toko minimum.
- **Notifications**: notifikasi dihitung dari data stok, menu, dan pesanan yang ada saat request diterima.

## Struktur folder

```text
backend-ikhsan/
├── src/
│   ├── controllers/     # Logika endpoint: auth, menu, inventory, order, team,
│   │                    # attendance, dashboard, settings, notification
│   ├── middleware/      # requireSession, requireOwner, sessionOf
│   ├── routes/          # Router Express per fitur
│   ├── utils/           # db, session, password, access, HTTP, seed, logger, tipe
│   ├── db.ts            # Pool PostgreSQL dan helper transaksi
│   ├── initDb.ts        # Inisialisasi schema, migrasi, seed, akun Owner
│   └── server.ts        # App Express, CORS, CSRF, logging, dan mount route
├── migrations/          # DDL absensi bersifat additive
├── logs/                # Output logger runtime (diabaikan Git)
├── .env.example         # Contoh konfigurasi lingkungan
├── package.json
├── tsconfig.json
└── test-logger.mjs      # Pengujian helper logger
```

## Prasyarat

- Node.js dan npm yang mendukung ESM serta target ES2022.
- PostgreSQL yang dapat diakses oleh aplikasi dan memiliki izin membuat tabel/index.
- Git untuk meng-clone repository.

Tidak diperlukan MySQL, JWT secret, atau bcrypt.

## Instalasi dan menjalankan server

1. Clone repository:

   ```bash
   git clone https://github.com/Dhoneew/wongkito-backend.git
   cd wongkito-backend
   ```

2. Install dependency:

   ```bash
   npm install
   ```

3. Buat file `.env` dari `.env.example`, lalu isi nilainya. Jangan commit `.env`.

   ```bash
   cp .env.example .env
   ```

   Variabel utama:

   ```text
   PORT=4000
   DATABASE_URL=
   FRONTEND_URL=http://localhost:3000
   ```

   - `PORT`: port Express, default `4000`.
   - `DATABASE_URL`: connection string PostgreSQL. Untuk hosted database yang memerlukan SSL, `.env.example` menunjukkan penggunaan `?sslmode=require`.
   - `FRONTEND_URL`: alamat frontend yang diizinkan CORS dan request tulis; dapat berisi beberapa URL dipisah koma.
   - Saat `NODE_ENV=production`, cookie sesi ditandai `Secure`.

4. Inisialisasi database:

   ```bash
   npm run init-db
   ```

5. Jalankan server:

   ```bash
   npm run dev
   ```

   Untuk menjalankan tanpa watch mode:

   ```bash
   npm run start
   ```

6. Cek server:

   ```bash
   curl http://localhost:4000/
   curl http://localhost:4000/api/health/db
   ```

## Database, schema, dan seed

`npm run init-db` melakukan hal berikut secara berurutan:

1. Membuat schema dasar dengan `CREATE TABLE IF NOT EXISTS`: akun dan sesi staf, menu, stok, pesanan, pengaturan toko, dan absensi.
2. Menjalankan `migrations/001_attendance_corrections.sql` sebagai satu sumber DDL koreksi absensi.
3. Mengisi menu, stok, dan pengaturan toko hanya jika tabelnya masih kosong, sehingga data yang sudah diubah Owner tidak ditimpa.
4. Membuat akun Owner `OWN-001` jika belum ada. Password sementara dicetak sekali saat pembuatan; pengguna harus menggantinya setelah login.

`npm run reset-owner` mereset password `OWN-001`, mencabut sesinya, lalu mencetak password sementara baru.

Migration absensi bersifat **additive dan idempotent**: hanya membuat tabel `attendance_corrections` dan index `attendance_corrections_attendance_id_idx` dengan `CREATE ... IF NOT EXISTS`. Migration tidak mengubah `attendance`, `staff_accounts`, atau tabel lama lainnya. Tidak tersedia file rollback/down migration.

## Scripts npm

| Script | Fungsi |
| --- | --- |
| `npm run dev` | Menjalankan server dengan `tsx watch` dan memuat `.env` jika ada |
| `npm run start` | Menjalankan server tanpa watch |
| `npm run init-db` | Menerapkan schema, migrasi, seed awal, dan memastikan akun Owner |
| `npm run reset-owner` | Mereset password Owner dan mencabut sesi Owner |
| `npm run typecheck` | Menjalankan `tsc --noEmit` |
| `npm run test:logger` | Menguji helper logger dengan direktori sementara |

## Endpoint API

Base URL lokal adalah `http://localhost:4000`. Frontend memanggil endpoint dengan path `/api/...`; pada konfigurasi frontend, path tersebut diteruskan ke backend melalui `BACKEND_URL`.

### Auth

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `POST` | `/api/auth/login` | Publik | Login `OWN-xxx`/`KSR-xxx`, menetapkan cookie sesi |
| `POST` | `/api/auth/logout` | Publik, cookie opsional | Menghapus sesi dan cookie; `204` |
| `GET` | `/api/auth/me` | Publik, cookie opsional | Mengembalikan `{ user }` atau `{ user: null }` |
| `PATCH` | `/api/auth/me` | Login | Mengubah nama akun sendiri |
| `POST` | `/api/auth/password` | Login | Mengubah password; sesi lain dicabut |

### Menu

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/api/menu` | Login | Owner melihat semua menu; kasir hanya menu tersedia |
| `POST` | `/api/menu` | Owner | Membuat menu |
| `PUT` | `/api/menu/:id` | Owner | Mengubah menu |
| `DELETE` | `/api/menu/:id` | Owner | Menghapus menu |

### Stock

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/api/stock` | Login | Daftar bahan baku |
| `POST` | `/api/stock` | Owner | Menambah bahan baku |
| `PUT` | `/api/stock/:id` | Owner | Mengubah bahan baku |

### Orders

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/api/orders` | Login | 500 pesanan terakhir |
| `POST` | `/api/orders` | Login | Checkout POS; harga/pajak/kembalian dihitung server |
| `PATCH` | `/api/orders/:id` | Login | Ubah status; `cancelled` hanya Owner |

### Team

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/api/accounts` | Owner | Daftar akun kasir `KSR-xxx` |
| `POST` | `/api/accounts` | Owner | Membuat kasir; login ID dibuat otomatis |
| `PATCH` | `/api/accounts/:loginId` | Owner | Mengubah profil/status; status `Nonaktif` mencabut sesi |
| `POST` | `/api/accounts/:loginId/reset-password` | Owner | Membuat password sementara dan mencabut sesi |

### Attendance

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/api/attendance` | Login | Owner melihat semua; kasir hanya dirinya. Query `from`/`to` `YYYY-MM-DD`, default 30 hari |
| `GET` | `/api/attendance/today` | Login | Absensi hari ini milik sendiri atau `null` |
| `POST` | `/api/attendance/check-in` | Kasir | Check-in sekali per hari |
| `POST` | `/api/attendance/check-out` | Kasir | Menutup absensi hari ini |
| `GET` | `/api/attendance/:id/corrections` | Owner | Riwayat koreksi absensi |
| `PATCH` | `/api/attendance/:id/correct` | Owner | Koreksi absensi disertai audit trail |

### Dashboard

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/api/dashboard/summary` | Login | Ringkasan penjualan harian, per jam, 7 hari, dan menu terlaris |

### Settings

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/api/settings/public` | Publik | Hanya nama, tagline, alamat, telepon, dan jam buka toko |
| `GET` | `/api/settings` | Login | Seluruh pengaturan toko |
| `PUT` | `/api/settings` | Owner | Mengganti pengaturan toko |

### Notifications

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/api/notifications` | Login | Notifikasi stok/menu/pesanan dihitung dari data saat ini |

### Public/system

| Method | Endpoint | Akses | Catatan |
| --- | --- | --- | --- |
| `GET` | `/` | Publik | Pesan bahwa backend berjalan |
| `GET` | `/api/health/db` | Publik | Memeriksa koneksi PostgreSQL |

Respons error berbentuk `{ "error": "pesan" }`. Status yang umum digunakan antara lain `400` (validasi), `401` (sesi habis), `403` (otorisasi), `404` (data/endpoint tidak ditemukan), `409` (konflik), `429` (rate limit), dan `503` (database belum siap). Setiap respons `/api` membawa header `X-Request-Id` dan `Cache-Control: no-store`.

## Absensi dan koreksi Owner

- Tanggal dan jam absensi memakai `Asia/Jakarta`. Check-in hanya sekali per hari; status hanya `Hadir` atau `Terlambat` dengan toleransi 15 menit setelah jam mulai shift yang tercantum pada akun kasir.
- Owner tidak dapat melakukan check-in/check-out; endpoint tersebut mengembalikan `403` untuk selain kasir.
- Check-out memakai `UPDATE ... WHERE check_out IS NULL RETURNING` sehingga permintaan ganda tidak bisa menutup absensi dua kali.
- Koreksi Owner (`PATCH /api/attendance/:id/correct`) berjalan dalam satu transaksi: baris absensi dikunci, snapshot `before` diambil, data diperbarui, snapshot `after` disimpan, lalu baris audit ditulis ke `attendance_corrections`.
- Koreksi mensyaratkan minimal satu field (`checkInTime`, `checkOutTime`, atau `status`), alasan 1–500 karakter, format waktu `HH:mm` 24 jam, status `Hadir`/`Terlambat`, dan check-out tidak lebih awal dari check-in. Waktu koreksi dipetakan ke tanggal absensi yang bersangkutan dengan offset `+07:00`.
- `GET /api/attendance/:id/corrections` hanya membaca audit trail; tidak ada endpoint untuk menghapus atau mengubah riwayat koreksi.

## Integrasi frontend

Backend ini dipakai oleh frontend Warkop Wong Kito (Next.js). Berdasarkan konfigurasi pada repository frontend, request `/api/*` diteruskan ke backend melalui variabel `BACKEND_URL`, sementara backend mengizinkan origin frontend melalui `FRONTEND_URL`.

Branch backend yang saat ini digunakan untuk integrasi adalah **`ikhsan`**. README ini tidak menyatakan bahwa branch tersebut telah di-merge ke `main`.

## Keterbatasan yang diketahui

- Belum ada endpoint laporan terpisah; data laporan berasal dari `GET /api/dashboard/summary`.
- Notifikasi bersifat computation-on-read dan hanya tersedia via `GET /api/notifications`; tidak ada penyimpanan notifikasi, websocket, atau push.
- Rate limiter login/ganti password berupa memori per proses server, sehingga hitungan tidak bersamaan jika dijalankan pada beberapa instance.
- Status absensi hanya `Hadir`/`Terlambat`; check-in dan check-out ditujukan untuk tanggal kerja `Asia/Jakarta` yang sama. Koreksi waktu tidak dirancang untuk shift lintas tengah malam.
- Migration absensi tidak menyediakan script rollback/down; perubahan bersifat additive dan idempotent.
- `npm run init-db` hanya mengisi tabel yang kosong dan tidak menimpa data yang sudah ada.
