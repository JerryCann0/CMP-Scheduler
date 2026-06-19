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
//    If a task was accelerated (actual < planned), its solo coalition
//    value is forced to at least -accelerationAmount, i.e. the total
//    project time is always decreased by the acceleration amount in
//    the solo coalition, even if the task is on a non-critical path.
//    All other coalition values are unchanged.
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
  const players = tasks; // All tasks are treated as players for Shapley analysis

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

  // ── Apply acceleration adjustment to ALL coalitions containing
  //    an accelerated player ────────────────────────────────────
  //
  // For accelerated tasks (actual < planned), the CPM forward pass
  // may show no change if the task is on a non-critical path.  The
  // intended rule is that the project duration is ALWAYS reduced by
  // the full acceleration amount whenever an accelerated player is
  // included in a coalition.
  //
  // We iterate coalitions in ascending mask order (fewest members
  // first).  For every coalition S that contains accelerated player i
  // we enforce:
  //
  //   v(S) ≤ v(S \ {i}) - acceleration
  //
  // i.e. adding i to any existing coalition must reduce the coalition
  // value by at least the acceleration.  Taking the minimum respects
  // cases where the CPM already shows a larger reduction.
  //
  // Processing in ascending mask order guarantees that when we adjust
  // v(S), the value v(S \ {i}) has already been adjusted (or was
  // never changed because it contains no accelerated players).

  // Collect accelerated players once
  const accelerations = players.map(p => p.plannedDuration - p.actualDuration);

  for (let mask = 1; mask < totalCoalitions; mask++) {
    for (let bit = 0; bit < n; bit++) {
      if (!(mask & (1 << bit))) continue;          // player i not in S
      const accel = accelerations[bit];
      if (accel <= 0) continue;                    // not accelerated

      const withoutI = mask ^ (1 << bit);          // S \ {i}
      const forcedValue = coalitionValue[withoutI] - accel;
      if (coalitionValue[mask] > forcedValue) {
        coalitionValue[mask] = forcedValue;
      }
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

// ════════════════════════════════════════════════════════════════════
//  DEBUG VERSION – Step-by-step trace of Shapley Value computation
//
//  Returns the same object as computeShapleyValues(), with an added
//  `debugLog` array of { step, detail } entries that trace every
//  calculation in human-readable form.
// ════════════════════════════════════════════════════════════════════
function computeShapleyValuesDebug(tasks, plannedProjectDuration) {
  const log = [];
  const step = (label, detail) => log.push({ step: label, detail });

  // ── Helper: coalition bitmask → readable set notation ─────────
  function coalitionName(mask, players) {
    if (mask === 0) return "∅";
    const names = [];
    for (let bit = 0; bit < players.length; bit++) {
      if (mask & (1 << bit)) names.push(players[bit].name || players[bit].id);
    }
    return "{" + names.join(", ") + "}";
  }

  step("START", `Planned project duration = ${plannedProjectDuration}`);

  // Guard checks
  if (tasks.length === 0) { step("ABORT", "No tasks"); return null; }
  if (tasks.some(t => t.actualDuration === null || t.actualDuration === undefined)) {
    step("ABORT", "Some tasks missing actual durations");
    return null;
  }

  // ── Identify players ──────────────────────────────────────────
  const players = tasks.filter(t => t.actualDuration !== t.plannedDuration);
  step("PLAYERS", `${players.length} task(s) deviated from plan:`);
  players.forEach((p, i) => {
    const diff = p.actualDuration - p.plannedDuration;
    const label = diff > 0 ? `DELAYED by ${diff}` : `ACCELERATED by ${Math.abs(diff)}`;
    step("PLAYER", `  [${i}] "${p.name || p.id}" — planned: ${p.plannedDuration}, actual: ${p.actualDuration} → ${label}`);
  });

  // ── Actual project duration ───────────────────────────────────
  const allOverrides = new Map();
  tasks.forEach(t => { allOverrides.set(t.id, t.actualDuration); });
  const actualProjectDuration = computeProjectDurationWithOverrides(tasks, allOverrides);
  const totalDelay = actualProjectDuration - plannedProjectDuration;
  step("ACTUAL DURATION", `Actual project duration (all actuals applied) = ${actualProjectDuration}`);
  step("TOTAL DELAY", `Total delay = ${actualProjectDuration} - ${plannedProjectDuration} = ${totalDelay}`);

  if (players.length === 0) {
    step("DONE", "No deviations — all Shapley values are 0");
    return {
      results: tasks.map(t => ({
        id: t.id, name: t.name, planned: t.plannedDuration,
        actual: t.actualDuration, deviation: 0, shapleyValue: 0, responsibilityPct: 0
      })),
      totalDelay, shapleySum: 0,
      plannedDuration: plannedProjectDuration,
      actualDuration: actualProjectDuration,
      debugLog: log
    };
  }

  const n = players.length;
  const playerIds = players.map(p => p.id);
  const playerIdSet = new Set(playerIds);

  // ── Compute v(S) for every coalition ──────────────────────────
  step("COALITION VALUES", `Computing v(S) for all 2^${n} = ${1 << n} coalitions...`);
  const totalCoalitions = 1 << n;
  const coalitionValue = new Array(totalCoalitions);

  for (let mask = 0; mask < totalCoalitions; mask++) {
    const overrides = new Map();
    for (let bit = 0; bit < n; bit++) {
      if (mask & (1 << bit)) {
        const player = players[bit];
        overrides.set(player.id, player.actualDuration);
      }
    }
    const projDur = computeProjectDurationWithOverrides(tasks, overrides);
    coalitionValue[mask] = projDur - plannedProjectDuration;

    const cName = coalitionName(mask, players);
    step("v(S)", `  v(${cName}) = ${projDur} - ${plannedProjectDuration} = ${coalitionValue[mask]}`);
  }

  // ── Acceleration adjustment ───────────────────────────────────
  // For accelerated tasks, ensure every coalition that contains an
  // accelerated player reflects the full acceleration.  We process
  // masks in ascending order so v(S \ {i}) is always settled before
  // we use it to compute the forced value for v(S).
  step("ACCELERATION ADJ",
    "Applying acceleration adjustments to ALL coalitions containing " +
    "accelerated players (ascending mask order)..."
  );

  const accelerations = players.map(p => p.plannedDuration - p.actualDuration);

  for (let mask = 1; mask < totalCoalitions; mask++) {
    for (let bit = 0; bit < n; bit++) {
      if (!(mask & (1 << bit))) continue;       // player i not in coalition
      const accel = accelerations[bit];
      if (accel <= 0) continue;                 // not accelerated

      const withoutI = mask ^ (1 << bit);       // S \ {i}
      const forcedValue = coalitionValue[withoutI] - accel;

      if (coalitionValue[mask] > forcedValue) {
        const cName    = coalitionName(mask, players);
        const prevVal  = coalitionValue[mask];
        coalitionValue[mask] = forcedValue;
        step("ACCEL ADJUST",
          `  v(${cName}): CPM=${prevVal}, ` +
          `forced=v(${coalitionName(withoutI, players)})-${accel}=${forcedValue} → updated to ${forcedValue}`
        );
      }
    }
  }

  // ── Shapley value computation ─────────────────────────────────
  step("SHAPLEY CALC", `Computing Shapley values for ${n} players (n! = ${factorial(n)})...`);
  const nFactorial = factorial(n);
  const shapleyValues = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const iBit = 1 << i;
    const pName = players[i].name || players[i].id;
    step("SHAPLEY PLAYER", `\n  ── φ(${pName}) ──`);

    let runningTotal = 0;

    for (let mask = 0; mask < totalCoalitions; mask++) {
      if (mask & iBit) continue;

      const sSize = popcount(mask);
      const weight = factorial(sSize) * factorial(n - sSize - 1) / nFactorial;
      const vWithI = coalitionValue[mask | iBit];
      const vWithoutI = coalitionValue[mask];
      const marginal = vWithI - vWithoutI;
      const contribution = weight * marginal;
      runningTotal += contribution;

      const sName = coalitionName(mask, players);
      const sUnionI = coalitionName(mask | iBit, players);
      step("MARGINAL",
        `    S=${sName}, S∪{${pName}}=${sUnionI}` +
        `  |  |S|=${sSize}, weight=${sSize}!×${n - sSize - 1}!/${n}! = ${weight.toFixed(6)}` +
        `  |  v(S∪{i})=${vWithI}, v(S)=${vWithoutI}` +
        `  |  marginal=${marginal}` +
        `  |  weighted=${contribution.toFixed(6)}` +
        `  |  running total=${runningTotal.toFixed(6)}`
      );
    }

    shapleyValues[i] = runningTotal;
    step("SHAPLEY RESULT", `  → φ(${pName}) = ${runningTotal.toFixed(6)}`);
  }

  // ── Final summary ─────────────────────────────────────────────
  const shapleySum = shapleyValues.reduce((sum, v) => sum + v, 0);
  step("SHAPLEY SUM", `Sum of all Shapley values = ${shapleySum.toFixed(6)}`);
  step("EFFICIENCY CHECK",
    `Total delay = ${totalDelay}, Shapley sum = ${shapleySum.toFixed(6)}, ` +
    `difference = ${Math.abs(totalDelay - shapleySum).toFixed(6)}`
  );

  // ── Build results ─────────────────────────────────────────────
  const shapleyMap = new Map();
  for (let i = 0; i < n; i++) {
    shapleyMap.set(players[i].id, shapleyValues[i]);
  }

  const results = tasks.map(t => {
    const sv = shapleyMap.get(t.id) || 0;
    return {
      id: t.id, name: t.name,
      planned: t.plannedDuration, actual: t.actualDuration,
      deviation: t.actualDuration - t.plannedDuration,
      shapleyValue: sv,
      responsibilityPct: totalDelay !== 0 ? (sv / totalDelay) * 100 : 0
    };
  });

  step("DONE", "Analysis complete.");

  return {
    results,
    totalDelay,
    shapleySum,
    plannedDuration: plannedProjectDuration,
    actualDuration: actualProjectDuration,
    debugLog: log
  };
}

// ── Pretty-print the debug log to console ──────────────────────────
function printShapleyDebugLog(debugLog) {
  if (!debugLog || debugLog.length === 0) {
    console.log("No debug log available.");
    return;
  }
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║       SHAPLEY VALUE COMPUTATION — DEBUG TRACE           ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  debugLog.forEach(entry => {
    const tag = `[${entry.step}]`.padEnd(20);
    console.log(`${tag} ${entry.detail}`);
  });
  console.log("\n════════════════════════════════════════════════════════════\n");
}
