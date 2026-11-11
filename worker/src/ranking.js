/**
 * Wilson 95% lower-bound ranking, exposure tiers, trust levels, and anti-manipulation rules.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 95% lower bound of Wilson score interval on weighted up/down votes.
 */
export function wilsonLowerBound(wUp, wDown) {
  const n = wUp + wDown;
  if (n <= 0) return 0;
  const z = 1.96;
  const z2 = z * z;
  const p = wUp / n;
  const numerator = p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  const denominator = 1 + z2 / n;
  return Math.max(0, numerator / denominator);
}

/**
 * Compute exposure tier per spec:
 * - recommended: Wilson >= 0.45 with >= 3 weighted votes, OR accepted answer
 * - low: Wilson < 0.20 with >= 5 weighted votes
 * - new: age <= 7 days and < 3 weighted votes
 * - normal: otherwise
 */
export function computeTier({ wUp, wDown, createdAt, isAcceptedAnswer = false, now = Date.now() }) {
  if (isAcceptedAnswer) return 'recommended';
  const totalWeight = wUp + wDown;
  const score = wilsonLowerBound(wUp, wDown);
  if (totalWeight >= 3 && score >= 0.45) return 'recommended';
  if (totalWeight >= 5 && score < 0.2) return 'low';
  if (now - createdAt <= 7 * DAY_MS && totalWeight < 3) return 'new';
  return 'normal';
}

export function getVoteWeightForUser(user, now = Date.now()) {
  if (!user) return 0;
  // Accounts younger than 7 days have 0 vote weight (anti-manipulation)
  if (now - user.created_at < 7 * DAY_MS) return 0;
  switch (user.level) {
    case 'moderator':
      return 2;
    case 'veteran':
      return 2;
    case 'active':
      return 1;
    case 'new':
    default:
      return 0;
  }
}

export function canPublishImmediately(user) {
  return user.level === 'active' || user.level === 'veteran' || user.level === 'moderator' || user.role === 'moderator' || user.role === 'admin';
}

export function canAnswerQuestions(user) {
  return user.level === 'active' || user.level === 'veteran' || user.level === 'moderator' || user.role === 'moderator' || user.role === 'admin';
}

export function isModerator(user) {
  return user?.role === 'moderator' || user?.role === 'admin';
}

/**
 * Parse and update per-user daily counters stored in users.daily_counts JSON.
 */
export function readDailyCounts(user, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  try {
    const parsed = JSON.parse(user.daily_counts || '{}');
    if (parsed.date === today) {
      return {
        date: today,
        posts: Number(parsed.posts) || 0,
        votes: Number(parsed.votes) || 0,
        reports: Number(parsed.reports) || 0,
      };
    }
  } catch {
    // ignore malformed json
  }
  return { date: today, posts: 0, votes: 0, reports: 0 };
}

/**
 * Evaluate and apply automatic trust level progression for a user:
 * - new -> active: >= 3 approved (published) records AND account age >= 3 days
 * - active -> veteran: >= 20 approved records, >= 70% helpful ratio, and no upheld report in last 30 days
 */
export async function maybePromoteUser(env, userId, now = Date.now()) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').bind(userId).first();
  if (!user || user.level === 'moderator') return user;

  const stats = await env.DB.prepare(`
    SELECT
      COUNT(*) AS published_count,
      COALESCE(SUM(up_count), 0) AS total_up,
      COALESCE(SUM(down_count), 0) AS total_down
    FROM notes
    WHERE author_id = ? AND status = 'published'
  `).bind(userId).first();

  const publishedCount = Number(stats?.published_count || 0);
  const totalUp = Number(stats?.total_up || 0);
  const totalDown = Number(stats?.total_down || 0);
  const totalVotes = totalUp + totalDown;
  const helpfulRatio = totalVotes > 0 ? totalUp / totalVotes : 1;

  const recentUpheld = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt
    FROM reports r
    JOIN notes n ON n.id = r.note_id
    WHERE n.author_id = ? AND r.resolution = 'upheld' AND r.resolved_at >= ?
  `).bind(userId, now - 30 * DAY_MS).first();

  const hasRecentUpheld = Number(recentUpheld?.cnt || 0) > 0;
  let nextLevel = user.level;

  if (user.level === 'new') {
    if (publishedCount >= 3 && now - user.created_at >= 3 * DAY_MS && !hasRecentUpheld) {
      nextLevel = 'active';
    }
  }
  if ((nextLevel === 'active' || user.level === 'active') && !hasRecentUpheld) {
    if (publishedCount >= 20 && totalVotes >= 5 && helpfulRatio >= 0.7) {
      nextLevel = 'veteran';
    }
  }

  if (nextLevel !== user.level) {
    await env.DB.prepare('UPDATE users SET level = ? WHERE id = ?').bind(nextLevel, userId).run();
    user.level = nextLevel;
  }
  return user;
}

/**
 * Demote user level automatically after an upheld report (veteran -> active, active -> new).
 */
export async function demoteOnUpheldReport(env, userId) {
  const user = await env.DB.prepare('SELECT id, level FROM users WHERE id = ?').bind(userId).first();
  if (!user || user.level === 'moderator') return;
  const next = user.level === 'veteran' ? 'active' : (user.level === 'active' ? 'new' : 'new');
  if (next !== user.level) {
    await env.DB.prepare('UPDATE users SET level = ? WHERE id = ?').bind(next, userId).run();
  }
}

/**
 * Bump book version so index ETag changes immediately on published changes.
 */
export async function bumpBookVersion(env, bookUid, now = Date.now()) {
  if (!bookUid) return;
  await env.DB.prepare(`
    INSERT INTO book_versions (book_uid, version, updated_at)
    VALUES (?, 1, ?)
    ON CONFLICT(book_uid) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at
  `).bind(bookUid, now).run();
}
