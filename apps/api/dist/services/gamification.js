import { sqlite } from '../db/index.js';
import { v4 as uuidv4 } from 'uuid';
export const LEVELS = [
    { level: 1, name: 'Tablonero', minPoints: 0, badge: '🏟️' },
    { level: 2, name: 'Popular', minPoints: 100, badge: '⚽' },
    { level: 3, name: 'Socio', minPoints: 300, badge: '🎫' },
    { level: 4, name: 'Hincha Fiel', minPoints: 700, badge: '🏅' },
    { level: 5, name: 'Millonario', minPoints: 1500, badge: '💎' },
    { level: 6, name: 'Leyenda del Millo', minPoints: 3000, badge: '👑' },
];
export const POINT_ACTIONS = {
    READ_ARTICLE: 5,
    READ_ANALYSIS: 15,
    READ_HISTORY: 10,
    DAILY_LOGIN: 10,
    REGISTER: 50,
    COMPLETE_PROFILE: 25,
    WEEKLY_STREAK: 100,
    TEN_ARTICLES_DAY: 30,
};
export function getLevelForPoints(points) {
    return [...LEVELS].reverse().find(l => points >= l.minPoints) || LEVELS[0];
}
export function getNextLevel(currentLevel) {
    return LEVELS.find(l => l.level === currentLevel + 1) || null;
}
// Award points to a user
export function awardPoints(userId, action, articleId) {
    const user = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user)
        return null;
    const points = POINT_ACTIONS[action];
    const newTotal = user.total_points + points;
    const oldLevel = getLevelForPoints(user.total_points);
    const newLevelData = getLevelForPoints(newTotal);
    const levelUp = newLevelData.level > oldLevel.level;
    // Save transaction
    sqlite.prepare(`
    INSERT INTO point_transactions (id, user_id, points, action, article_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidv4(), userId, points, action, articleId || null);
    // Update user total and level
    sqlite.prepare(`
    UPDATE users SET total_points = ?, level = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newTotal, newLevelData.level, userId);
    // Check for new badges
    checkAndAwardBadges(userId, newTotal);
    return {
        points,
        newTotal,
        levelUp,
        newLevel: levelUp ? newLevelData : undefined,
    };
}
// Check if user has already read an article today
export function hasReadArticleToday(userId, articleId) {
    const result = sqlite.prepare(`
    SELECT id FROM point_transactions
    WHERE user_id = ? AND article_id = ? AND action LIKE 'READ_%'
    AND date(created_at) = date('now')
  `).get(userId, articleId);
    return !!result;
}
// Check and award badges based on total points
export function checkAndAwardBadges(userId, totalPoints) {
    const availableBadges = sqlite.prepare(`
    SELECT * FROM badges WHERE points_required <= ? AND points_required > 0
  `).all(totalPoints);
    for (const badge of availableBadges) {
        sqlite.prepare(`
      INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)
    `).run(userId, badge.id);
    }
}
// Get user profile with gamification data
export function getUserProfile(userId) {
    const user = sqlite.prepare(`
    SELECT id, email, username, avatar_url, level, total_points, role, created_at
    FROM users WHERE id = ?
  `).get(userId);
    if (!user)
        return null;
    const currentLevel = getLevelForPoints(user.total_points);
    const nextLevel = getNextLevel(currentLevel.level);
    const badges = sqlite.prepare(`
    SELECT b.*, ub.earned_at FROM badges b
    JOIN user_badges ub ON b.id = ub.badge_id
    WHERE ub.user_id = ?
    ORDER BY ub.earned_at DESC
  `).all(userId);
    const recentTransactions = sqlite.prepare(`
    SELECT * FROM point_transactions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(userId);
    const todayPoints = sqlite.prepare(`
    SELECT COALESCE(SUM(points), 0) as total FROM point_transactions
    WHERE user_id = ? AND date(created_at) = date('now')
  `).get(userId);
    return {
        ...user,
        currentLevel,
        nextLevel,
        progressToNextLevel: nextLevel
            ? Math.round(((user.total_points - currentLevel.minPoints) / (nextLevel.minPoints - currentLevel.minPoints)) * 100)
            : 100,
        badges,
        recentTransactions,
        todayPoints: todayPoints.total,
    };
}
// Get global leaderboard
export function getLeaderboard(limit = 50) {
    return sqlite.prepare(`
    SELECT id, username, avatar_url, level, total_points
    FROM users
    ORDER BY total_points DESC
    LIMIT ?
  `).all(limit);
}
// Record daily login
export function recordDailyLogin(userId) {
    const lastLogin = sqlite.prepare(`
    SELECT created_at FROM point_transactions
    WHERE user_id = ? AND action = 'DAILY_LOGIN'
    AND date(created_at) = date('now')
  `).get(userId);
    if (lastLogin)
        return { alreadyLoggedIn: true };
    const result = awardPoints(userId, 'DAILY_LOGIN');
    return { alreadyLoggedIn: false, points: result?.points };
}
