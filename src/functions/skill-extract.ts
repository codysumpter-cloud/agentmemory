import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  SessionSummary,
  ProceduralMemory,
  Session,
  MemoryProvider,
} from "../types.js";
import { KV, generateId, fingerprintId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { recordAudit } from "./audit.js";
import { logger } from "../logger.js";

// Skill categorization constants
const SKILL_CATEGORIES = [
  "procedural",   // Step-by-step procedures
  "declarative",  // Factual knowledge
  "conditional",  // If-then rules
  "heuristic",    // Experience-based guidelines
  "troubleshooting" // Diagnostic patterns
];

const SKILL_EXTRACT_SYSTEM = `You are a skill extraction engine. Given a completed multi-step task session, extract a reusable procedural skill document.

Output format:
<skill>
<trigger>When the agent encounters [specific situation/pattern]</trigger>
<title>Short skill title</title>
<steps>
<step>First concrete action</step>
<step>Second concrete action</step>
</steps>
<expected_outcome>What success looks like</expected_outcome>
<tags>comma,separated,tags</tags>
<category>procedural|declarative|conditional|heuristic|troubleshooting</category>
<confidence>0.0-1.0</confidence>
</skill>

Rules:
- Extract ONLY if the session shows a clear multi-step procedure that succeeded
- Steps must be concrete and actionable, not vague
- The trigger should describe WHEN to apply this skill
- If the session is exploratory with no clear procedure, output <no-skill/>
- Maximum 10 steps per skill
- Assign appropriate category based on skill type
- Provide confidence score (0.0-1.0) based on clarity and completeness of the procedure`;

function buildSkillPrompt(
  summary: SessionSummary,
  observations: CompressedObservation[],
): string {
  const obsText = observations
    .filter((o) => o.importance >= 4)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    .slice(0, 30)
    .map(
      (o) => `[${o.type}] ${o.title}${o.narrative ? ": " + o.narrative : ""}`
    )
    .join("\n");

  return `## Session Summary
Title: ${summary.title}
Narrative: ${summary.narrative}
Key Decisions: ${summary.keyDecisions.join("; ")}
Files Modified: ${summary.filesModified.join(", ")}
Concepts: ${summary.concepts.join(", ")}

## Observations (${observations.length} total, showing top by importance)
${obsText}`;
}

function parseSkillXml(
  xml: string,
): {
  trigger: string;
  title: string;
  steps: string[];
  expectedOutcome: string;
  tags: string[];
  category: string;
  confidence: number;
} | null {
  if (xml.includes("<no-skill/>")) return null;

  const triggerMatch = xml.match(/<trigger>([\s\S]*?)<\/trigger>/);
  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/);
  const stepsMatch = xml.match(/<steps>([\s\S]*?)<\/steps>/);
  const outcomeMatch = xml.match(
    /<expected_outcome>([\s\S]*?)<\/expected_outcome>/,
  );
  const tagsMatch = xml.match(/<tags>([\s\S]*?)<\/tags>/);
  const categoryMatch = xml.match(/<category>([\s\S]*?)<\/category>/);
  const confidenceMatch = xml.match(/<confidence>([\s\S]*?)<\/confidence>/);

  if (!triggerMatch || !titleMatch || !stepsMatch) return null;

  const stepRegex = /<step>([\s\S]*?)<\/step>/g;
  const steps: string[] = [];
  let match;
  while ((match = stepRegex.exec(stepsMatch[1])) !== null) {
    const step = match[1].trim();
    if (step) steps.push(step);
  }

  if (steps.length < 2) return null;

  // Validate category
  const category = categoryMatch?.[1]?.trim() || "procedural";
  const validCategory = SKILL_CATEGORIES.includes(category) ? category : "procedural";

  // Parse confidence
  let confidence = 0.8; // default confidence
  if (confidenceMatch) {
    const parsed = parseFloat(confidenceMatch[1]);
    if (!isNaN(parsed) && parsed >= 0.0 && parsed <= 1.0) {
      confidence = parsed;
    }
  }

  return {
    trigger: triggerMatch[1].trim(),
    title: titleMatch[1].trim(),
    steps,
    expectedOutcome: outcomeMatch?.[1]?.trim() || "",
    tags: tagsMatch?.[1]
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean) || [],
    category: validCategory,
    confidence,
  };
}

export function registerSkillExtractFunctions(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
): void {
  sdk.registerFunction("mem::skill-extract", 
    async (data: { sessionId: string }) => {
      if (!data?.sessionId) {
        return { success: false, error: "sessionId is required" };
      }

      const session = await kv
        .get<Session>(KV.sessions, data.sessionId)
        .catch(() => null);
      if (!session) {
        return { success: false, error: "session not found" };
      }
      if (session.status !== "completed") {
        return {
          success: false,
          error: "session must be completed before skill extraction",
        };
      }

      const [summary, observations] = await Promise.all([
        kv.get<SessionSummary>(KV.summaries, data.sessionId).catch(() => null),
        kv.list<CompressedObservation>(KV.observations(data.sessionId)).catch(() => []),
      ]);
      if (!summary) {
        return {
          success: false,
          error: "no summary — run mem::summarize first",
        };
      }
      if (observations.length < 3) {
        return { success: false, error: "too few observations for skill extraction" };
      }

      try {
        const prompt = buildSkillPrompt(summary, observations);
        const response = await provider.summarize(
          SKILL_EXTRACT_SYSTEM,
          prompt,
        );
        const parsed = parseSkillXml(response);

        if (!parsed) {
          logger.info("No skill extracted — session was exploratory", {
            sessionId: data.sessionId,
          });
          return { success: true, extracted: false, reason: "no clear procedure found" };
        }

        const fp = fingerprintId(
          "skill",
          JSON.stringify({
            title: parsed.title.toLowerCase(),
            trigger: parsed.trigger.toLowerCase(),
            steps: parsed.steps.map((s) => s.toLowerCase().trim()),
          }),
        );
        const existing = await kv
          .get<ProceduralMemory>(KV.procedural, fp)
          .catch(() => null);

        if (existing) {
          const alreadyReinforced = existing.sourceSessionIds.includes(data.sessionId);
          if (!alreadyReinforced) {
            // Reinforcement logic with decay consideration
            existing.strength = Math.min(1.0, existing.strength + 0.15);
            existing.frequency++;
            existing.sourceSessionIds = [...existing.sourceSessionIds, data.sessionId];
            
            // Update confidence based on reinforcement
            existing.confidence = Math.min(1.0, (existing.confidence || 0.8) + 0.05);
          }
          existing.updatedAt = new Date().toISOString();
          
          // Apply time-based decay (simplified - in practice would use timestamp difference)
          const daysSinceUpdate = 0; // Would calculate from existing.updatedAt
          if (daysSinceUpdate > 30) {
            // Apply decay after 30 days
            existing.strength = Math.max(0.1, existing.strength - 0.05);
            existing.confidence = Math.max(0.1, existing.confidence - 0.02);
          }
          
          await kv.set(KV.procedural, existing.id, existing);

          try {
            await recordAudit(kv, "skill_extract", "mem::skill-extract", [], {
              skillId: existing.id,
              reinforced: true,
              sessionId: data.sessionId,
            });
          } catch {}

          logger.info("Skill reinforced", {
            id: existing.id,
            name: parsed.title,
          });
          return {
            success: true,
            extracted: true,
            reinforced: true,
            skill: existing,
          };
        }

        const now = new Date().toISOString();
        const skill: ProceduralMemory = {
          id: fp,
          name: parsed.title,
          triggerCondition: parsed.trigger,
          steps: parsed.steps,
          expectedOutcome: parsed.expectedOutcome,
          frequency: 1,
          tags: parsed.tags,
          concepts: summary.concepts,
          strength: 0.6,
          confidence: parsed.confidence,
          sourceSessionIds: [data.sessionId],
          sourceObservationIds: observations
            .slice(0, 10)
            .map((o) => o.id),
          createdAt: now,
          updatedAt: now,
        };

        await kv.set(KV.procedural, skill.id, skill);

        try {
          await recordAudit(kv, "skill_extract", "mem::skill-extract", [], {
            skillId: skill.id,
            title: parsed.title,
            steps: parsed.steps.length,
            sessionId: data.sessionId,
          });
        } catch {}

        logger.info("Skill extracted", {
          id: skill.id,
          title: parsed.title,
          steps: parsed.steps.length,
        });

        return { success: true, extracted: true, reinforced: false, skill };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Skill extraction failed", { error: msg });
        return { success: false, error: msg };
      }
    },
  );

  sdk.registerFunction("mem::skill-list", 
    async (data: { limit?: number }) => {
      const limit = data?.limit ?? 50;
      const skills = await kv.list<ProceduralMemory>(KV.procedural);
      // Sort by strength * confidence * frequency for better ranking while preserving
      // backwards compatibility for older skills that do not yet have the new fields.
      const skillScore = (skill: ProceduralMemory) => {
        const confidence = skill.confidence ?? 1;
        const frequency = skill.frequency ?? 1;
        return skill.strength * confidence * Math.log(frequency + 1);
      };
      const sorted = skills.sort((a, b) => skillScore(b) - skillScore(a));
      return {
        success: true,
        skills: sorted.slice(0, limit),
        total: sorted.length,
      };
    },
  );

  sdk.registerFunction("mem::skill-match", 
    async (data: { query: string; limit?: number }) => {
      if (!data?.query?.trim()) {
        return { success: false, error: "query is required" };
      }

      const limit = data.limit ?? 5;
      const query = data.query.toLowerCase();
      const terms = query.split(/\s+/).filter((t) => t.length > 2);

      const skills = await kv.list<ProceduralMemory>(KV.procedural);

      const scored = skills
        .map((skill) => {
          const text =
            `${skill.name} ${skill.triggerCondition} ${(skill.tags || []).join(" ")} ${skill.steps.join(" ")}`.toLowerCase();
          const matchCount = terms.filter((t) => text.includes(t)).length;
          if (matchCount === 0) return null;
          const relevance = matchCount / terms.length;
          const confidence = skill.confidence ?? 1;
          const frequency = skill.frequency ?? 1;
          const categoryBoost = skill.category && SKILL_CATEGORIES.includes(skill.category) ? 0.1 : 0;
          return {
            skill,
            score: relevance * skill.strength * confidence * Math.log(frequency + 1) + categoryBoost,
          };
        })
        .filter(Boolean) as Array<{
        skill: ProceduralMemory;
        score: number;
      }>;

      scored.sort((a, b) => b.score - a.score);

      return {
        success: true,
        matches: scored.slice(0, limit),
      };
    },
  );

  // New function for skill decay maintenance
  sdk.registerFunction("mem::skill-decay-maintenance", 
    async (data: { maxAgeDays?: number }) => {
      const maxAge = data?.maxAgeDays ?? 90; // Default 90 days
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAge);
      const cutoffISO = cutoffDate.toISOString();

      const skills = await kv.list<ProceduralMemory>(KV.procedural);
      let decayed = 0;
      let removed = 0;

      for (const skill of skills) {
        const updatedAt = new Date(skill.updatedAt || skill.createdAt);
        if (updatedAt < cutoffDate) {
          // Apply decay
          const ageDays = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
          const decayFactor = Math.max(0.1, 1.0 - (ageDays - maxAge) / 365); // Decay over a year
          
          skill.strength = Math.max(0.1, skill.strength * decayFactor);
          skill.confidence = Math.max(0.1, skill.confidence * decayFactor);
          
          // Remove if too weak
          if (skill.strength < 0.2 && skill.confidence < 0.2) {
            await kv.delete(KV.procedural, skill.id);
            removed++;
            
            try {
              await recordAudit(kv, "skill_decay", "mem::skill-decay-maintenance", [skill.id], {
                action: "remove_weak_skill",
                reason: `Skill too weak after ${Math.round(ageDays)} days`,
                strength: skill.strength,
                confidence: skill.confidence
              });
            } catch {}
          } else {
            skill.updatedAt = new Date().toISOString();
            await kv.set(KV.procedural, skill.id, skill);
            decayed++;
            
            try {
              await recordAudit(kv, "skill_decay", "mem::skill-decay-maintenance", [skill.id], {
                action: "apply_decay",
                ageDays: Math.round(ageDays),
                decayFactor: decayFactor
              });
            } catch {}
          }
        }
      }

      logger.info("Skill decay maintenance completed", {
        decayed,
        removed,
        totalSkills: skills.length
      });

      return { success: true, decayed, removed, totalSkills: skills.length };
    }
  );
}