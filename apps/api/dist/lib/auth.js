/**
 * auth.ts — Token y password utilities
 * Reemplaza SHA-256 con bcrypt y base64 con JWT firmado.
 */
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
const BCRYPT_ROUNDS = 12;
function getSecret() {
    const s = process.env.JWT_SECRET;
    if (!s && process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET no configurada');
    }
    return s || 'dev-secret-change-in-production';
}
// ─── Password ─────────────────────────────────────────────────────────────────
export async function hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
}
export async function verifyPassword(password, hash) {
    return bcrypt.compare(password, hash);
}
export function signToken(payload) {
    return jwt.sign(payload, getSecret(), { expiresIn: '30d' });
}
export function verifyToken(token) {
    try {
        return jwt.verify(token, getSecret());
    }
    catch {
        return null;
    }
}
// ─── Password validation ──────────────────────────────────────────────────────
export function validatePassword(password) {
    if (password.length < 8)
        return { ok: false, error: 'Mínimo 8 caracteres' };
    if (!/[A-Za-z]/.test(password))
        return { ok: false, error: 'Debe incluir al menos una letra' };
    if (!/[0-9]/.test(password))
        return { ok: false, error: 'Debe incluir al menos un número' };
    return { ok: true };
}
