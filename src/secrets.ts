/**
 * Secrets management – AES-256-GCM encryption at rest.
 * Keys are stored in the `secrets` SQLite table as encrypted blobs.
 * The master key is derived from HUB_SECRET_KEY via PBKDF2.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
  timingSafeEqual,
} from 'crypto';
import { getDb } from './db';
import { getConfig } from './config';

// Fixed salt for key derivation (non-secret, ensures consistent key derivation)
const KDF_SALT = Buffer.from('ai-access-hub-v1-kdf-salt-2024', 'utf8');
const KDF_ITERATIONS = 100_000;

let _encKey: Buffer | null = null;

function getEncKey(): Buffer {
  if (_encKey) return _encKey;
  const { secretKey } = getConfig();
  _encKey = pbkdf2Sync(secretKey, KDF_SALT, KDF_ITERATIONS, 32, 'sha256');
  return _encKey;
}

// ─── Encryption / decryption ──────────────────────────────────────────────────

function encrypt(plaintext: string): string {
  const key = getEncKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Layout: 1 byte version | 16 byte iv | 16 byte authTag | N byte ciphertext
  const payload = Buffer.concat([Buffer.from([1]), iv, authTag, encrypted]);
  return payload.toString('base64');
}

function decrypt(encoded: string): string {
  const key = getEncKey();
  const buf = Buffer.from(encoded, 'base64');
  const version = buf[0];
  if (version !== 1) throw new Error(`Unknown secret encoding version: ${version}`);
  const iv = buf.slice(1, 17);
  const authTag = buf.slice(17, 33);
  const ciphertext = buf.slice(33);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function setSecret(key: string, value: string): void {
  const db = getDb();
  const encrypted = encrypt(value);
  db.prepare(`
    INSERT INTO secrets (key, value, updated) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated
  `).run(key, encrypted, Date.now());
}

export function getSecret(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    return decrypt(row.value);
  } catch {
    return null;
  }
}

export function deleteSecret(key: string): void {
  const db = getDb();
  db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
}

export function listSecretKeys(): string[] {
  const db = getDb();
  const rows = db.prepare('SELECT key FROM secrets ORDER BY key').all() as { key: string }[];
  return rows.map(r => r.key);
}

/** Mask a secret value for safe logging / UI display */
export function maskSecret(value: string): string {
  if (!value) return '(empty)';
  if (value.length <= 8) return '***';
  return value.slice(0, 4) + '***' + value.slice(-2);
}

// ─── Admin token hashing ──────────────────────────────────────────────────────

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyAdminToken(provided: string): boolean {
  const { adminToken } = getConfig();
  // Use timing-safe comparison
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(adminToken).digest();
  return timingSafeEqual(a, b);
}

// ─── Client token helpers ─────────────────────────────────────────────────────

export function generateToken(length = 40): string {
  return randomBytes(length).toString('base64url');
}

export function verifyClientToken(token: string): {
  valid: boolean;
  projectId?: string;
  readOnly?: boolean;
  tokenId?: string;
} {
  const db = getDb();
  const hash = hashToken(token);
  const row = db
    .prepare(
      'SELECT id, project_id, read_only, last_used FROM client_tokens WHERE token_hash = ?',
    )
    .get(hash) as { id: string; project_id: string; read_only: number; last_used: number | null } | undefined;

  if (!row) return { valid: false };

  // Update last_used
  db.prepare('UPDATE client_tokens SET last_used = ? WHERE id = ?').run(Date.now(), row.id);

  return {
    valid: true,
    projectId: row.project_id,
    readOnly: row.read_only === 1,
    tokenId: row.id,
  };
}

export function createClientToken(label: string, projectId: string, readOnly = false): string {
  const db = getDb();
  const token = generateToken();
  const hash = hashToken(token);
  const id = randomBytes(16).toString('hex');

  db.prepare(`
    INSERT INTO client_tokens (id, label, token_hash, project_id, read_only, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, label, hash, projectId, readOnly ? 1 : 0, Date.now());

  return token;
}

export function listClientTokens(): { id: string; label: string; projectId: string; readOnly: boolean; createdAt: number; lastUsed: number | null }[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT id, label, project_id, read_only, created_at, last_used FROM client_tokens ORDER BY created_at DESC')
    .all() as { id: string; label: string; project_id: string; read_only: number; created_at: number; last_used: number | null }[];
  return rows.map(r => ({
    id: r.id,
    label: r.label,
    projectId: r.project_id,
    readOnly: r.read_only === 1,
    createdAt: r.created_at,
    lastUsed: r.last_used,
  }));
}

export function revokeClientToken(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM client_tokens WHERE id = ?').run(id);
}

// ─── Approval tokens (short-lived, single-use for downgrade approval) ─────────
const _approvalTokens = new Map<string, { expiresAt: number; context: string }>();

export function issueApprovalToken(context: string, ttlMs = 5 * 60_000): string {
  const token = randomBytes(20).toString('hex');
  _approvalTokens.set(token, { expiresAt: Date.now() + ttlMs, context });
  // Cleanup expired tokens
  for (const [k, v] of _approvalTokens) {
    if (v.expiresAt < Date.now()) _approvalTokens.delete(k);
  }
  return token;
}

export function consumeApprovalToken(token: string): string | null {
  const entry = _approvalTokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    _approvalTokens.delete(token);
    return null;
  }
  _approvalTokens.delete(token);
  return entry.context;
}
