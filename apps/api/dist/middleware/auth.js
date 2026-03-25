import { verifyToken } from '../lib/auth.js';
export function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        return res.status(401).json({ error: 'No autenticado' });
    const payload = verifyToken(header.slice(7));
    if (!payload)
        return res.status(401).json({ error: 'Token inválido o expirado' });
    req.userId = payload.userId;
    req.userRole = payload.role;
    next();
}
export function requireAdmin(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        return res.status(401).json({ error: 'No autenticado' });
    const payload = verifyToken(header.slice(7));
    if (!payload)
        return res.status(401).json({ error: 'Token inválido o expirado' });
    if (payload.role !== 'admin')
        return res.status(403).json({ error: 'Acceso denegado' });
    req.userId = payload.userId;
    req.userRole = payload.role;
    next();
}
