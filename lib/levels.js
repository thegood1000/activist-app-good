// מנגנון דרגות פשוט - סף מצטבר לכל דרגה. אפשר לשנות בעתיד בלי לשנות מבנה DB.
const LEVELS = [
  { name: 'מגויס', min: 0 },
  { name: 'פעיל', min: 100 },
  { name: 'פעיל מוביל', min: 300 },
  { name: 'מפקד צוות', min: 700 },
  { name: 'שגריר', min: 1500 },
  { name: 'אלוף פעילים', min: 3000 },
];

function getLevel(points) {
  let current = LEVELS[0];
  let next = LEVELS[1] || null;
  for (let i = 0; i < LEVELS.length; i++) {
    if (points >= LEVELS[i].min) {
      current = LEVELS[i];
      next = LEVELS[i + 1] || null;
    }
  }
  const progress = next
    ? Math.max(0, Math.min(1, (points - current.min) / (next.min - current.min)))
    : 1;
  return {
    name: current.name,
    next: next ? next.name : null,
    pointsToNext: next ? next.min - points : 0,
    progress,
  };
}

module.exports = { LEVELS, getLevel };
