/**
 * Test file for fuzzy search scoring logic.
 * Run: npx vitest run src/lib/fuzzy-search.test.ts
 */

// ─── Copy of scoring functions from slash-command-picker.tsx ───

const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
const SCORE_MATCH_CONSECUTIVE = 1.0;
const SCORE_MATCH_SLASH = 0.9;
const SCORE_MATCH_WORD = 0.8;
const SCORE_MATCH_CAPITAL = 0.7;
const SCORE_MATCH_DOT = 0.6;
const SCORE_MAX_LEADING_GAP = -0.05;

function bonusFor(prev: string, curr: string): number {
  if (prev === "/") return SCORE_MATCH_SLASH;
  if (prev === "-" || prev === "_" || prev === " ") return SCORE_MATCH_WORD;
  if (prev === ".") return SCORE_MATCH_DOT;
  if (prev === prev.toLowerCase() && curr === curr.toUpperCase())
    return SCORE_MATCH_CAPITAL;
  return 0;
}

function fuzzyScore(query: string, candidate: string): number {
  const n = query.length;
  const m = candidate.length;
  if (n === 0) return 0;
  if (n > m) return -Infinity;

  const qLower = query.toLowerCase();
  const cLower = candidate.toLowerCase();

  let qi = 0;
  for (let ci = 0; ci < m && qi < n; ci++) {
    if (qLower[qi] === cLower[ci]) qi++;
  }
  if (qi < n) return -Infinity;

  const D: number[][] = [];
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    D.push(new Array(m).fill(-Infinity));
    M.push(new Array(m).fill(-Infinity));
  }

  for (let i = 0; i < n; i++) {
    let prevScore = -Infinity;
    const gapScore = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;
    for (let j = 0; j < m; j++) {
      if (qLower[i] === cLower[j]) {
        let score = 0;
        if (i === 0) {
          score =
            j === 0
              ? SCORE_MATCH_CONSECUTIVE
              : Math.max(SCORE_MAX_LEADING_GAP, SCORE_GAP_LEADING * j) +
                bonusFor(candidate[j - 1], candidate[j]);
        } else if (j > 0) {
          const consecutive = D[i - 1][j - 1] + SCORE_MATCH_CONSECUTIVE;
          const boundary =
            M[i - 1][j - 1] + bonusFor(candidate[j - 1], candidate[j]);
          score = Math.max(consecutive, boundary);
        }
        D[i][j] = score;
        M[i][j] = Math.max(score, prevScore + gapScore);
      } else {
        D[i][j] = -Infinity;
        M[i][j] = prevScore + gapScore;
      }
      prevScore = M[i][j];
    }
  }
  return M[n - 1][m - 1];
}

function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  const dp: number[] = Array.from({ length: m + 1 }, (_, i) => i);
  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }
  return dp[m];
}

function typoScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const maxDist = Math.max(1, Math.floor(q.length / 3));
  let bestDist = Infinity;
  const minWin = Math.max(1, q.length - maxDist);
  const maxWin = q.length + maxDist;
  for (let winLen = minWin; winLen <= maxWin && winLen <= c.length; winLen++) {
    for (let start = 0; start + winLen <= c.length; start++) {
      const sub = c.slice(start, start + winLen);
      const dist = levenshtein(q, sub);
      if (dist < bestDist) {
        bestDist = dist;
        if (dist === 0) break;
      }
    }
    if (bestDist === 0) break;
  }
  if (bestDist > maxDist) return -Infinity;
  return -0.5 - bestDist * 0.5;
}

interface FakeCmd {
  name: string;
  full_command: string;
  description: string | null;
}

function scoreCommand(cmd: FakeCmd, q: string): number {
  const cmdKey = cmd.full_command.slice(1);
  const cmdScore = fuzzyScore(q, cmdKey);
  const nameScore = fuzzyScore(q, cmd.name);

  // Description: only substring (contains) match to avoid false positives
  let descScore = -Infinity;
  if (cmd.description?.toLowerCase().includes(q.toLowerCase())) {
    descScore = q.length * 0.3;
  }

  const fuzzy = Math.max(cmdScore, nameScore, descScore);
  if (fuzzy > -Infinity) return fuzzy;
  const typo = Math.max(typoScore(q, cmdKey), typoScore(q, cmd.name));
  return typo;
}

// ─── Test data ───

const COMMANDS: FakeCmd[] = [
  {
    name: "biorxiv-database",
    full_command: "/biorxiv-database",
    description: "Efficient database search tool for bioRxiv preprint server.",
  },
  {
    name: "biopython",
    full_command: "/biopython",
    description: "Comprehensive molecular biology toolkit.",
  },
  {
    name: "bioservices",
    full_command: "/bioservices",
    description: "Unified Python interface to 40+ bioinformatics services.",
  },
  {
    name: "cbioportal-database",
    full_command: "/cbioportal-database",
    description: "Query cBioPortal for cancer genomics data.",
  },
  {
    name: "scikit-bio",
    full_command: "/scikit-bio",
    description: "Biological data toolkit.",
  },
  {
    name: "scvi-tools",
    full_command: "/scvi-tools",
    description: "Deep generative models for single-cell omics.",
  },
  {
    name: "vaex",
    full_command: "/vaex",
    description: "Large tabular datasets.",
  },
  {
    name: "deepchem",
    full_command: "/deepchem",
    description: "Molecular ML with diverse featurizers.",
  },
  {
    name: "market-research-reports",
    full_command: "/market-research-reports",
    description: "Market research reports.",
  },
  {
    name: "matlab",
    full_command: "/matlab",
    description: "MATLAB and GNU Octave.",
  },
  {
    name: "scanpy",
    full_command: "/scanpy",
    description: "scRNA-seq analysis.",
  },
  {
    name: "phylogenetics",
    full_command: "/phylogenetics",
    description: "Phylogenetic trees.",
  },
  {
    name: "perplexity-search",
    full_command: "/perplexity-search",
    description: "AI-powered web searches.",
  },
  {
    name: "latchbio-integration",
    full_command: "/latchbio-integration",
    description: "Latch platform for bioinformatics.",
  },
];

function search(q: string): { name: string; score: number }[] {
  const results: { name: string; score: number }[] = [];
  for (const cmd of COMMANDS) {
    const score = scoreCommand(cmd, q);
    if (score > -Infinity) {
      results.push({ name: cmd.full_command, score });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ─── Tests ───

import { describe, it, expect } from "vitest";

describe("fuzzyScore", () => {
  it("exact prefix match scores high", () => {
    expect(fuzzyScore("bio", "biopython")).toBeGreaterThan(0);
  });

  it("subsequence match works", () => {
    expect(fuzzyScore("bpy", "biopython")).toBeGreaterThan(-Infinity);
  });

  it("non-matching returns -Infinity", () => {
    expect(fuzzyScore("xyz", "biopython")).toBe(-Infinity);
  });

  it("extra char in query fails subsequence", () => {
    // bioarxiv has 'a' that doesn't exist in biorxiv in order
    expect(fuzzyScore("bioarxiv", "biorxiv-database")).toBe(-Infinity);
  });
});

describe("levenshtein", () => {
  it("identical strings = 0", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });
  it("one insertion = 1", () => {
    expect(levenshtein("bioarxiv", "biorxiv")).toBe(1);
  });
  it("one substitution = 1", () => {
    expect(levenshtein("scanpy", "scnpy")).toBe(1);
  });
});

describe("typoScore", () => {
  it("bioarxiv matches biorxiv-database", () => {
    const score = typoScore("bioarxiv", "biorxiv-database");
    console.log("typoScore('bioarxiv', 'biorxiv-database') =", score);
    expect(score).toBeGreaterThan(-Infinity);
  });

  it("bioarxiv does NOT match cbioportal-database", () => {
    const score = typoScore("bioarxiv", "cbioportal-database");
    console.log("typoScore('bioarxiv', 'cbioportal-database') =", score);
    expect(score).toBe(-Infinity);
  });

  it("scnpy matches scanpy", () => {
    expect(typoScore("scnpy", "scanpy")).toBeGreaterThan(-Infinity);
  });
});

describe("scoreCommand", () => {
  it("bioarxiv should match biorxiv-database via typo", () => {
    const cmd = COMMANDS.find((c) => c.name === "biorxiv-database")!;
    const score = scoreCommand(cmd, "bioarxiv");
    console.log("scoreCommand(biorxiv-database, 'bioarxiv') =", score);
    expect(score).toBeGreaterThan(-Infinity);
  });
});

describe("search ranking", () => {
  it("'bioarxiv' should have biorxiv-database as top result", () => {
    const results = search("bioarxiv");
    console.log("search('bioarxiv'):", results.slice(0, 5));
    expect(results[0].name).toBe("/biorxiv-database");
  });

  it("'bioarxiv' should NOT match cbioportal-database", () => {
    const results = search("bioarxiv");
    const hasCbio = results.some((r) => r.name === "/cbioportal-database");
    expect(hasCbio).toBe(false);
  });

  it("'bio' should have biopython and biorxiv-database near top", () => {
    const results = search("bio");
    console.log("search('bio'):", results.slice(0, 5));
    const bioNames = results.slice(0, 5).map((r) => r.name);
    expect(bioNames).toContain("/biopython");
    expect(bioNames).toContain("/biorxiv-database");
  });

  it("'bpy' subsequence should match biopython", () => {
    const results = search("bpy");
    console.log("search('bpy'):", results.slice(0, 5));
    expect(results.some((r) => r.name === "/biopython")).toBe(true);
  });

  it("'scanpy' exact should be top result", () => {
    const results = search("scanpy");
    expect(results[0].name).toBe("/scanpy");
  });

  it("'matlab' exact should be top result", () => {
    const results = search("matlab");
    expect(results[0].name).toBe("/matlab");
  });
});
