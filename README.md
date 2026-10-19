# Wong Kito Backend

Backend API untuk aplikasi Warkop Wong Kito (WKM), yang digunakan untuk menangani autentikasi pengguna dan mendukung integrasi dengan web dashboard.

## Teknologi

- Node.js
- Express.js
- TypeScript
- MySQL
- JSON Web Token (JWT)
- bcrypt

## Fitur

- Registrasi pengguna
- Login pengguna
- Autentikasi menggunakan JWT
- Middleware autentikasi dan otorisasi berdasarkan role
- Koneksi database MySQL

## Persyaratan

Pastikan sudah menginstal:

- Node.js dan npm
- MySQL

## Cara Menjalankan

1. Clone repository:

   ```bash
   git clone https://github.com/Dhoneew/wongkito-backend.git
   ```

2. Masuk ke folder proyek:

   ```bash
   cd wongkito-backend
   ```

3. Instal dependency:

   ```bash
   npm install
   ```

4. Buat file `.env` berdasarkan konfigurasi database dan JWT yang digunakan aplikasi.

5. Jalankan server menggunakan script yang tersedia di `package.json`.

## Keamanan

Jangan mengunggah file `.env`, password database, JWT secret, atau kredensial lainnya ke repository publik.

## Status Proyek

Sedang dalam tahap pengembangan.
