"use strict";

// ════════════════════════════════════════════════════════════════════
//  Shapley Value Delay / Acceleration Analysis
//
//  Players  = tasks whose actual duration ≠ planned duration
//  v(S)     = change in project duration when coalition S uses actual
//             durations and all others use planned durations
//  φᵢ       = Shapley value for player i (fair share of total delay)
//
//  Special rule – Acceleration:
//    If a task's solo coalition v({i}) < 0 (it alone would shorten
//    the project), decrease its solo coalition value's magnitude by
//    the acceleration amount.  All other coalition values unchanged.
// ════════════════════════════════════════════════════════════════════

// ── Topological Sort (Kahn's algorithm) ────────────────────────────
// Returns an array of task ids in topological order, or null if a
// cycle is detected.
function topologicalSort(tasks) {
  const idSet = new Set(tasks.map(t => t.id));
  const inDeg = {};
  tasks.forEach(t => { inDeg[t.id] = 0; });
  tasks.forEach(t => {
    t.predecessors.forEach(pid => {
      if (idSet.has(pid)) inDeg[t.id]++;
    });
  });

  const queue = [];
  tasks.forEach(t => { if (inDeg[t.id] === 0) queue.push(t.id); });

  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    tasks.forEach(t => {
      if (t.predecessors.includes(id)) {
        inDeg[t.id]--;
        if (inDeg[t.id] === 0) queue.push(t.id);
      }
    });
  }

  return sorted.length === tasks.length ? sorted : null;
}

// ── Forward-pass project duration with duration overrides ──────────
// durationOverrides is a Map(taskId → duration).  Tasks not in the
// map use their plannedDuration.
function computeProjectDurationWithOverrides(tasks, durationOverrides) {
  const sorted = topologicalSort(tasks);
  if (!sorted) return 0; // cycle — shouldn't happen if scheduler validated

  const map = {};
  tasks.forEach(t => {
    map[t.id] = {
      id: t.id,
      predecessors: t.predecessors,
      duration: durationOverrides.has(t.id)
        ? durationOverrides.get(t.id)
        : t.plannedDuration,
      ef: 0
    };
  });

  sorted.forEach(id => {
    const node = map[id];
    let es = 0;
    if (node.predecessors.length > 0) {
      es = Math.max(...node.predecessors.map(pid => map[pid] ? map[pid].ef : 0));
    }
    node.ef = es + node.duration;
  });

  return Math.max(...Object.values(map).map(n => n.ef), 0);
}

// ── Factorial helper ───────────────────────────────────────────────
function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

// ── Main: Compute Shapley Values ───────────────────────────────────
// Returns { results, totalDelay, shapleySum, plannedDuration,
//           actualDuration } or null if analysis is not possible.
function computeShapleyValues(tasks, plannedProjectDuration) {
  // Guard: need all actual durations filled in
  if (tasks.length === 0) return null;
  if (tasks.some(t => t.actualDuration === null || t.actualDuration === undefined)) {
    return null;
  }

  // Identify deviated tasks (players)
  const players = tasks.filter(t => t.actualDuration !== t.plannedDuration);

  // Compute actual project duration (all deviations applied)
  const allOverrides = new Map();
  tasks.forEach(t => { allOverrides.set(t.id, t.actualDuration); });
  const actualProjectDuration = computeProjectDurationWithOverrides(tasks, allOverrides);
  const totalDelay = actualProjectDuration - plannedProjectDuration;

  // If no tasks deviated, everything is zero
  if (players.length === 0) {
    return {
      results: tasks.map(t => ({
        id: t.id,
        name: t.name,
        planned: t.plannedDuration,
        actual: t.actualDuration,
        deviation: 0,
        shapleyValue: 0,
        responsibilityPct: 0
      })),
      totalDelay,
      shapleySum: 0,
      plannedDuration: plannedProjectDuration,
      actualDuration: actualProjectDuration
    };
  }

  const n = players.length;
  const playerIds = players.map(p => p.id);
  const playerIdSet = new Set(playerIds);

  // ── Pre-compute v(S) for every coalition S ⊆ players ─────────
  // We represent each coalition as a bitmask over the players array.
  // coalitionValue[mask] = project duration change for that coalition.
  const totalCoalitions = 1 << n;
  const coalitionValue = new Array(totalCoalitions);

  for (let mask = 0; mask < totalCoalitions; mask++) {
    // Build duration overrides: players in the coalition use actual,
    // everyone else uses planned (default in the function).
    const overrides = new Map();
    for (let bit = 0; bit < n; bit++) {
      if (mask & (1 << bit)) {
        const player = players[bit];
        overrides.set(player.id, player.actualDuration);
      }
    }

    const projDur = computeProjectDurationWithOverrides(tasks, overrides);
    coalitionValue[mask] = projDur - plannedProjectDuration;
  }

  // ── Apply acceleration adjustment to solo coalitions ──────────
  // If v({i}) < 0, decrease its magnitude by the acceleration amount.
  // "decrease magnitude by acceleration amount" for a negative value
  // means moving it closer to zero:  v({i}) = v({i}) - v({i}) = 0
  // More precisely: the acceleration amount IS |v({i})|, so
  // new v({i}) = v({i}) + |v({i})| = 0  ... but the instruction says
  // "decrease its solo coalition value by the amount of acceleration"
  // which means: v({i}) += |acceleration|.
  // Since acceleration = -v({i}) when v({i}) < 0:
  //   new v({i}) = v({i}) + (-v({i})) = 0
  // Wait, re-reading: "In the case of an acceleration please decrease
  // its solo coalition value by the amount of acceleration."
  // acceleration amount = |v({i})| (a positive number).
  // "decrease its solo coalition value by the amount" →
  //   new v({i}) = v({i}) - accelerationAmount
  //   = v({i}) - |v({i})|
  //   = negative - positive → makes it more negative.
  // But that contradicts "Keep all other values the same" and the
  // general intent of reducing responsibility for acceleration.
  //
  // Re-reading again: "decrease its solo coalition value by the
  // amount of acceleration".  The solo coalition value is negative.
  // The value represents days of delay. To "decrease" a negative
  // value (make it less negative / closer to zero), we ADD the
  // acceleration amount:
  //   new v({i}) = v({i}) + accelerationAmount
  // This makes the most sense in context: the task accelerated but
  // we reduce how much credit it gets for that acceleration.

  for (let bit = 0; bit < n; bit++) {
    const soloMask = 1 << bit;
    if (coalitionValue[soloMask] < 0) {
      const accelerationAmount = Math.abs(coalitionValue[soloMask]);
      coalitionValue[soloMask] += accelerationAmount; // moves toward 0
    }
  }

  // ── Compute Shapley values ────────────────────────────────────
  // φᵢ = Σ over S ⊆ N\{i}:
  //       [ |S|! × (n-|S|-1)! / n! ] × [ v(S∪{i}) - v(S) ]
  const nFactorial = factorial(n);
  const shapleyValues = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const iBit = 1 << i;

    // Enumerate all subsets S of N\{i}
    // We iterate over all masks that do NOT contain bit i
    for (let mask = 0; mask < totalCoalitions; mask++) {
      if (mask & iBit) continue; // skip coalitions containing i

      const sSize = popcount(mask);
      const weight = factorial(sSize) * factorial(n - sSize - 1) / nFactorial;
      const marginalContribution = coalitionValue[mask | iBit] - coalitionValue[mask];

      shapleyValues[i] += weight * marginalContribution;
    }
  }

  // ── Build results ─────────────────────────────────────────────
  // Map Shapley values back to all tasks (non-deviated tasks get 0)
  const shapleyMap = new Map();
  for (let i = 0; i < n; i++) {
    shapleyMap.set(players[i].id, shapleyValues[i]);
  }

  const shapleySum = shapleyValues.reduce((sum, v) => sum + v, 0);

  const results = tasks.map(t => {
    const sv = shapleyMap.get(t.id) || 0;
    return {
      id: t.id,
      name: t.name,
      planned: t.plannedDuration,
      actual: t.actualDuration,
      deviation: t.actualDuration - t.plannedDuration,
      shapleyValue: sv,
      responsibilityPct: totalDelay !== 0 ? (sv / totalDelay) * 100 : 0
    };
  });

  return {
    results,
    totalDelay,
    shapleySum,
    plannedDuration: plannedProjectDuration,
    actualDuration: actualProjectDuration
  };
}

// ── Popcount: count set bits in an integer ─────────────────────────
function popcount(x) {
  let count = 0;
  while (x) {
    count += x & 1;
    x >>= 1;
  }
  return count;
}
