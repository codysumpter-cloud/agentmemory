import type { ISdk } from "iii-sdk";
import { getContext } from "iii-sdk";
import type {
  Memory,
  SemanticMemory,
  RetentionScore,
  DecayConfig,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { AccessLog } from "./access-tracker.js";
import {
  emptyAccessLog,
  deleteAccessLog,
  normalizeAccessLog,
} from "./access-tracker.js";

const DEFAULT_DECAY: DecayConfig = {
  lambda: 0.01,
  sigma: 0.3,
  tierThresholds: {
    hot: 0.7,
    warm: 0.4,
    cold: 0.15,
  },
};

function resolveDecayConfig(
  input?: Partial<DecayConfig>,
): { config: DecayConfig } | { error: string } {
  const tierThresholds = {
    ...DEFAULT_DECAY.tierThresholds,
    ...(input?.tierThresholds ?? {}),
  };
  const config: DecayConfig = {
    lambda:
      typeof input?.lambda === "number" ? input.lambda : DEFAULT_DECAY.lambda,
    sigma: typeof input?.sigma === "number" ? input.sigma : DEFAULT_DECAY.sigma,
    tierThresholds,
  };

  if (!Number.isFinite(config.lambda) || config.lambda <= 0) {
    return { error: "config.lambda must be a positive number" };
  }
  if (!Number.isFinite(config.sigma) || config.sigma < 0) {
    return { error: "config.sigma must be a non-negative number" };
  }
  const { hot, warm, cold } = config.tierThresholds;
  if (![hot, warm, cold].every((v) => Number.isFinite(v))) {
    return {
      error: "config.tierThresholds.hot/warm/cold must be finite numbers",
    };
  }
  if (!(hot >= warm && warm >= cold && cold >= 0)) {
    return {
      error:
        "config.tierThresholds must satisfy hot >= warm >= cold >= 0",
    };
  }
  return { config };
}

function computeReinforcementBoost(
  accessTimestamps: number[],
  sigma: number,
): number {
  const now = Date.now();
  let boost = 0;
  for (const tAccess of accessTimestamps) {
    if (!Number.isFinite(tAccess)) continue;
    const daysSinceAccess = (now - tAccess) / (1000 * 60 * 60 * 24);
    if (daysSinceAccess > 0) {
      boost += 1 / daysSinceAccess;
    }
  }
  return boost * sigma;
}

function computeRetention(
  salience: number,
  createdAt: string,
  accessTimestamps: number[],
  config: DecayConfig,
): number {
  const deltaT =
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  const temporalDecay = Math.exp(-config.lambda * deltaT);
  const reinforcementBoost = computeReinforcementBoost(
    accessTimestamps,
    config.sigma,
  );
  return Math.min(1, salience * temporalDecay + reinforcementBoost);
}

function computeSalience(
  memory: Memory | SemanticMemory,
  accessCount: number,
): number {
  let baseSalience = 0.5;

  if ("type" in memory) {
    const typeWeights: Record<string, number> = {
      architecture: 0.9,
      bug: 0.7,
      pattern: 0.8,
      preference: 0.85,
      workflow: 0.6,
      fact: 0.5,
    };
    baseSalience = typeWeights[(memory as Memory).type] || 0.5;
  }

  if ("confidence" in memory) {
    baseSalience = Math.max(baseSalience, (memory as SemanticMemory).confidence);
  }

  const accessBonus = Math.min(0.2, accessCount * 0.02);
  return Math.min(1, baseSalience + accessBonus);
}

export function registerRetentionFunctions(
  sdk: ISdk,
  kv: StateKV,
): void {
  sdk.registerFunction("mem::retention-score",
    async (data: { config?: Partial<DecayConfig> }) => {
      const ctx = getContext();
      const resolved = resolveDecayConfig(data?.config);
      if ("error" in resolved) {
        return { success: false, error: resolved.error };
      }
      const { config } = resolved;

      const [memories, semanticMems, allLogs] = await Promise.all([
        kv.list<Memory>(KV.memories),
        kv.list<SemanticMemory>(KV.semantic),
        kv.list<unknown>(KV.accessLog).catch(() => [] as unknown[]),
      ]);
      const logsById = new Map<string, AccessLog>();
      for (const raw of allLogs) {
        const log = normalizeAccessLog(raw);
        if (log.memoryId) logsById.set(log.memoryId, log);
      }

      const scores: RetentionScore[] = [];

      const computeDecay = (createdAt: string): number =>
        Math.exp(
          -config.lambda *
            ((Date.now() - new Date(createdAt).getTime()) /
              (1000 * 60 * 60 * 24)),
        );

      for (const mem of memories) {
        if (!mem.isLatest) continue;
        const log = logsById.get(mem.id) ?? emptyAccessLog(mem.id);
        const salience = computeSalience(mem, log.count);
        const temporalDecay = computeDecay(mem.createdAt);
        const reinforcementBoost = computeReinforcementBoost(
          log.recent,
          config.sigma,
        );
        const score = Math.min(
          1,
          salience * temporalDecay + reinforcementBoost,
        );

        const entry: RetentionScore = {
          memoryId: mem.id,
          sourceBucket: KV.memories,
          score,
          salience,
          temporalDecay,
          reinforcementBoost,
          lastAccessed: log.lastAt || mem.updatedAt,
          accessCount: log.count,
        };

        scores.push(entry);
        await kv.set(KV.retentionScores, mem.id, entry);
      }

      for (const sem of semanticMems) {
        const log = logsById.get(sem.id) ?? emptyAccessLog(sem.id);

        // Pre-0.8.3 fallback: use sem.lastAccessedAt only when mem:access is empty.
        let accessTimestamps: number[];
        let effectiveCount: number;
        if (log.recent.length > 0 || log.count > 0) {
          accessTimestamps = log.recent;
          effectiveCount = log.count;
        } else if (sem.lastAccessedAt) {
          const legacyTs = Date.parse(sem.lastAccessedAt);
          accessTimestamps = Number.isFinite(legacyTs) ? [legacyTs] : [];
          effectiveCount = sem.accessCount;
        } else {
          accessTimestamps = [];
          effectiveCount = sem.accessCount;
        }

        const salience = computeSalience(sem, effectiveCount);
        const temporalDecay = computeDecay(sem.createdAt);
        const reinforcementBoost = computeReinforcementBoost(
          accessTimestamps,
          config.sigma,
        );
        const score = Math.min(
          1,
          salience * temporalDecay + reinforcementBoost,
        );

        const entry: RetentionScore = {
          memoryId: sem.id,
          sourceBucket: KV.semantic,
          score,
          salience,
          temporalDecay,
          reinforcementBoost,
          lastAccessed: log.lastAt || sem.lastAccessedAt,
          accessCount: effectiveCount,
        };

        scores.push(entry);
        await kv.set(KV.retentionScores, sem.id, entry);
      }

      scores.sort((a, b) => b.score - a.score);

      const tiers = {
        hot: scores.filter((s) => s.score >= config.tierThresholds.hot)
          .length,
        warm: scores.filter(
          (s) =>
            s.score >= config.tierThresholds.warm &&
            s.score < config.tierThresholds.hot,
        ).length,
        cold: scores.filter(
          (s) =>
            s.score >= config.tierThresholds.cold &&
            s.score < config.tierThresholds.warm,
        ).length,
        evictable: scores.filter(
          (s) => s.score < config.tierThresholds.cold,
        ).length,
      };

      ctx.logger.info("Retention scores computed", {
        total: scores.length,
        ...tiers,
      });

      return { success: true, total: scores.length, tiers, scores };
    },
  );

  sdk.registerFunction("mem::retention-evict", 
    async (data: {
      threshold?: number;
      dryRun?: boolean;
      maxEvict?: number;
    }) => {
      const ctx = getContext();
      const threshold = data.threshold ?? DEFAULT_DECAY.tierThresholds.cold;
      const maxEvict = data.maxEvict ?? 50;

      const allScores = await kv.list<RetentionScore>(KV.retentionScores);
      const candidates = allScores
        .filter((s) => s.score < threshold)
        .sort((a, b) => a.score - b.score)
        .slice(0, maxEvict);

      if (data.dryRun) {
        return {
          success: true,
          dryRun: true,
          wouldEvict: candidates.length,
          candidates: candidates.map((c) => ({
            id: c.memoryId,
            score: c.score,
          })),
        };
      }

      let evicted = 0;
      let failed = 0;
      for (const candidate of candidates) {
        const [primaryDelete, scoreDelete] = await Promise.all([
          kv
            .delete(
              candidate.sourceBucket || KV.retentionScores,
              candidate.memoryId,
            )
            .then(() => true)
            .catch((err) => {
              ctx.logger.warn("Retention primary delete failed", {
                memoryId: candidate.memoryId,
                sourceBucket: candidate.sourceBucket,
                error: err instanceof Error ? err.message : String(err),
              });
              return false;
            }),
          kv
            .delete(KV.retentionScores, candidate.memoryId)
            .then(() => true)
            .catch((err) => {
              ctx.logger.warn("Retention score delete failed", {
                memoryId: candidate.memoryId,
                error: err instanceof Error ? err.message : String(err),
              });
              return false;
            }),
        ]);

        if (primaryDelete || scoreDelete) {
          evicted++;
          await deleteAccessLog(kv, candidate.memoryId).catch((err) => {
            ctx.logger.warn("Retention access-log delete failed", {
              memoryId: candidate.memoryId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        if (!primaryDelete || !scoreDelete) {
          failed++;
        }
      }

      ctx.logger.info("Retention-based eviction complete", {
        evicted,
        failed,
        threshold,
      });

      return { success: failed === 0, evicted, failed };
    },
  );
}
