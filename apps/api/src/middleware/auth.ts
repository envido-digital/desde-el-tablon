import { type Request, type Response, type NextFunction } from 'express';
import { verifyToken } from '../lib/auth.js';
import { sqlite } from '../db/index.js';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autenticado' });
  const payload = verifyToken(header.slice(7));
  if (!payload) return res.status(401).json({ error: 'Token inválido o expirado' });
  (req as any).userId = payload.userId;
  (req as any).userRole = payload.role;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No autenticado' });
  const payload = verifyToken(header.slice(7));
  if (!payload) return res.status(401).json({ error: 'Token inválido o expirado' });
  if (payload.role !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  (req as any).userId = payload.userId;
  (req as any).userRole = payload.role;
  next();
}
