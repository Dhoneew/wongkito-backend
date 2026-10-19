
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { testConnection } from "./db.js";
import authRoutes from "./routes/auth.routes.js";
import {
  authenticateToken,
  authorizeRoles,
  type AuthRequest,
} from "./middleware/auth.middleware.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);

app.use(cors());
app.use(express.json());

// Memeriksa identitas pengguna dari token
app.get(
  "/api/auth/me",
  authenticateToken,
  (req: AuthRequest, res) => {
    res.json({
      success: true,
      message: "Token valid.",
      user: req.user,
    });
  }
);

// Endpoint pengujian khusus superadmin (owner)
app.get(
  "/api/owner/test",
  authenticateToken,
  authorizeRoles("superadmin"),
  (_req, res) => {
    res.json({
      success: true,
      message: "Akses owner berhasil.",
    });
  }
);

// Route autentikasi
app.use("/api/auth", authRoutes);

// Memeriksa backend
app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "Backend WKM berhasil berjalan!",
  });
});

// Memeriksa koneksi database
app.get("/api/health/db", async (_req, res) => {
  try {
    await testConnection();

    res.json({
      success: true,
      message: "Koneksi database WKM berhasil!",
    });
  } catch (error) {
    console.error("Koneksi database gagal:", error);

    res.status(500).json({
      success: false,
      message: "Koneksi database gagal. Periksa konfigurasi .env.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend berjalan di http://localhost:${PORT}`);
});
