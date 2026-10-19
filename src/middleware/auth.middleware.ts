
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

interface JwtPayload {
  id: number;
  email: string;
  role: "admin" | "superadmin";
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export function authenticateToken(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Token tidak ditemukan. Silakan login.",
    });
  }

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    return res.status(500).json({
      success: false,
      message: "Konfigurasi autentikasi server bermasalah.",
    });
  }

  try {
    const decoded = jwt.verify(token, secret);

    if (typeof decoded === "string") {
      return res.status(401).json({
        success: false,
        message: "Token tidak valid.",
      });
    }

    if (
      typeof decoded.id !== "number" ||
      typeof decoded.email !== "string" ||
      (decoded.role !== "admin" && decoded.role !== "superadmin")
    ) {
      return res.status(401).json({
        success: false,
        message: "Data token tidak valid.",
      });
    }

    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Token tidak valid atau sudah kedaluwarsa.",
    });
  }
}

export function authorizeRoles(...roles: JwtPayload["role"][]) {
  return (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Kamu tidak memiliki akses ke fitur ini.",
      });
    }

    next();
  };
}
