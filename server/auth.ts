import { Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserRole = "admin" | "operator";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  enabled: boolean;
  createdAt: string;
  lastLogin?: string;
  assignedVps?: string[]; // undefined = tutti i VPS (admin); array = VPS assegnati (operator)
}

export type SafeUser = Omit<User, "passwordHash">;

// ─── Persistenza su disco ─────────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const USERS_FILE = join(DATA_DIR, "users.json");

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadUsers(): Map<string, User> {
  ensureDataDir();
  try {
    if (existsSync(USERS_FILE)) {
      const arr: User[] = JSON.parse(readFileSync(USERS_FILE, "utf-8"));
      return new Map(arr.map(u => [u.id, u]));
    }
  } catch (e) {
    console.error("[Auth] Failed to load users.json:", e);
  }
  return new Map();
}

function saveUsers() {
  ensureDataDir();
  try {
    writeFileSync(USERS_FILE, JSON.stringify(Array.from(users.values()), null, 2), "utf-8");
  } catch (e) {
    console.error("[Auth] Failed to save users.json:", e);
  }
}

// ─── In-memory user store ─────────────────────────────────────────────────────

const users = loadUsers();

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

  user.lastLogin = new Date().toISOString();
  saveUsers();
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
  role: UserRole,
  assignedVps?: string[]
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
    assignedVps: role === "operator" ? (assignedVps ?? []) : undefined,
  };
  users.set(user.id, user);
  saveUsers();
  return toSafeUser(user);
}

export function updateUser(
  id: string,
  updates: { password?: string; role?: UserRole; enabled?: boolean; assignedVps?: string[] }
): SafeUser {
  const user = users.get(id);
  if (!user) throw new Error("Utente non trovato");

  if (updates.password !== undefined) {
    user.passwordHash = hashPassword(updates.password);
  }
  if (updates.role !== undefined) {
    user.role = updates.role;
    // Se passa da operator ad admin, rimuovi assignedVps
    if (updates.role === "admin") user.assignedVps = undefined;
  }
  if (updates.enabled !== undefined) {
    user.enabled = updates.enabled;
  }
  if (updates.assignedVps !== undefined && user.role === "operator") {
    user.assignedVps = updates.assignedVps;
  }

  saveUsers();
  return toSafeUser(user);
}

export function deleteUser(id: string): void {
  const user = users.get(id);
  if (!user) throw new Error("Utente non trovato");

  if (user.role === "admin") {
    const admins = Array.from(users.values()).filter(u => u.role === "admin" && u.enabled);
    if (admins.length <= 1) throw new Error("Impossibile eliminare l'unico admin");
  }

  users.delete(id);
  saveUsers();
}

/** Restituisce gli ID VPS a cui l'utente ha accesso. undefined = tutti. */
export function getUserAllowedVps(userId: string): string[] | undefined {
  const user = users.get(userId);
  if (!user) return [];
  if (user.role === "admin") return undefined; // tutti
  return user.assignedVps ?? [];
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

/** Controlla che l'utente (operator) abbia accesso al VPS specificato. */
export function requireVpsAccess(vpsId: string, userId: string): boolean {
  const allowed = getUserAllowedVps(userId);
  if (allowed === undefined) return true; // admin: accesso totale
  return allowed.includes(vpsId);
}

// Shorthand
export const requireOperator = requireRole("admin", "operator");
export const requireAdmin = requireRole("admin");
