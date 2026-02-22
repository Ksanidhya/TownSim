function pruneExpired(map, now) {
  for (const [key, until] of map.entries()) {
    if (!Number.isFinite(until) || until <= now) {
      map.delete(key);
    }
  }
}

export function createCooldownGate({ maxKeys = 2000 } = {}) {
  const byKey = new Map();
  return {
    allow(key, cooldownMs) {
      const k = String(key || "").trim();
      if (!k) return true;
      const now = Date.now();
      const until = byKey.get(k) || 0;
      if (until > now) return false;
      byKey.set(k, now + Math.max(0, Number(cooldownMs) || 0));
      if (byKey.size > Math.max(10, Number(maxKeys) || 2000)) {
        pruneExpired(byKey, now);
      }
      return true;
    },
    clear() {
      byKey.clear();
    },
    size() {
      return byKey.size;
    }
  };
}
