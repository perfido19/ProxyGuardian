import { Request, Response, NextFunction } from "express";
import * as crypto from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = "admin" | "operator" | "viewer";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  enabled: boolean;
  createdAt: string;
  lastLogin?: string;
}

export type SafeUser = Omit<User, "passwordHash">;

// ─── In-memory user store ─────────────────────────────────────────────────────

const users = new Map<string, User>();

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password + "proxydashboard_salt").digest("hex");
}

function generateId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function toSafeUser(user: User): SafeUser {
  const { passwordHash, ...safe } = user;
  return safe;
}

// Crea utente admin default al bootstrap
function initDefaultAdmin() {
  const existing = Array.from(users.values()).find(u => u.username === "admin");
  if (!existing) {
    const admin: User = {
      id: generateId(),
      username: "admin",
      passwordHash: hashPassword("admin123"),
      role: "admin",
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    users.set(admin.id, admin);
    console.log("[Auth] Default admin created (admin/admin123)");
  }
}

initDefaultAdmin();

// ─── Auth helpers ─────────────────────────────────────────────────────────────

export function validateCredentials(username: string, password: string): SafeUser | null {
  const user = Array.from(users.values()).find(
    u => u.username === username && u.enabled
  );
  if (!user) return null;
  if (user.passwordHash !== hashPassword(password)) return null;

  // Aggiorna lastLogin
  user.lastLogin = new Date().toISOString();
  return toSafeUser(user);
}

export function getAllUsers(): SafeUser[] {
  return Array.from(users.values()).map(toSafeUser);
}

export function getUserById(id: string): SafeUser | null {
  const user = users.get(id);
  return user ? toSafeUser(user) : null;
}

export function createUser(
  username: string,
  password: string,
  role: UserRole
): SafeUser {
  const existing = Array.from(users.values()).find(u => u.username === username);
  if (existing) throw new Error("Username già in uso");

  const user: User = {
    id: generateId(),
    username,
    passwordHash: hashPassword(password),
    role,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  users.set(user.id, user);
  return toSafeUser(user);
}

export function updateUser(
  id: string,
  updates: { password?: string; role?: UserRole; enabled?: boolean }
): SafeUser {
  const user = users.get(id);
  if (!user) throw new Error("Utente non trovato");

  if (updates.password !== undefined) {
    user.passwordHash = hashPassword(updates.password);
  }
  if (updates.role !== undefined) {
    user.role = updates.role;
  }
  if (updates.enabled !== undefined) {
    user.enabled = updates.enabled;
  }

  return toSafeUser(user);
}

export function deleteUser(id: string): void {
  const user = users.get(id);
  if (!user) throw new Error("Utente non trovato");

  // Impedisci di eliminare l'ultimo admin
  if (user.role === "admin") {
    const admins = Array.from(users.values()).filter(u => u.role === "admin" && u.enabled);
    if (admins.length <= 1) throw new Error("Impossibile eliminare l'unico admin");
  }

  users.delete(id);
}

// ─── Session type augmentation ────────────────────────────────────────────────

declare module "express-session" {
  interface SessionData {
    userId?: string;
    userRole?: UserRole;
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Non autenticato" });
    return;
  }

  const user = users.get(req.session.userId);
  if (!user || !user.enabled) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Sessione non valida" });
    return;
  }

  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      res.status(401).json({ error: "Non autenticato" });
      return;
    }

    const userRole = req.session.userRole;
    if (!userRole || !roles.includes(userRole)) {
      res.status(403).json({ error: "Permessi insufficienti" });
      return;
    }

    next();
  };
}

// Shorthand: solo admin e operator possono modificare
export const requireOperator = requireRole("admin", "operator");
// Solo admin
export const requireAdmin = requireRole("admin");
