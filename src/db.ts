
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

export const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "wkm_db",
  waitForConnections: true,
  connectionLimit: 10,
});

export async function testConnection() {
  const connection = await db.getConnection();

  try {
    console.log("Koneksi MySQL WKM berhasil!");
  } finally {
    connection.release();
  }
}
