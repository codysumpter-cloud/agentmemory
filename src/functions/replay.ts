import { homedir } from "node:os";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  RawObservation,
  Session,
} from "../types.js";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import { parseJsonlText } from "../replay/jsonl-parser.js";
import { projectTimeline, type Timeline } from "../replay/timeline.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/_.-])secret([\\/_.-]|s?$)/i,
  /(^|[\\/_.-])credentials?([\\/_.-]|$)/i,
  /(^|[\\/_.-])private[_-]?key([\\/_.-]|$)/i,
  /(^|[\\/])\.env(\.[\w-]+)?$/i,
  /(^|[\\/_.-])id_rsa([\\/_.-]|$)/i,
  /(^|[\\/])auth[_-]?token([\\/_.-]|$)/i,
  /(^|[\\/])bearer[_-]?token([\\/_.-]|$)/i,
  /(^|[\\/])access[_-]?token([\\/_.-]|$)/i,
  /(^|[\\/])api[_-]?token([\\/_.-]|$)/i,
];

export function isSensitive(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(path));
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

function rawFromCompressed(obs: CompressedObservation): RawObservation {
  return {
    id: obs.id,
    sessionId: obs.sessionId,
    timestamp: obs.timestamp,
    hookType: "post_tool_use",
    toolName: undefined,
    toolInput: undefined,
    toolOutput: undefined,
    userPrompt: obs.type === "conversation" ? obs.narrative : undefined,
    assistantResponse: undefined,
    raw: { title: obs.title, narrative: obs.narrative, facts: obs.facts },
  };
}

function isRawShape(o: unknown): o is RawObservation {
  if (!o || typeof o !== "object") return false;
  const r = o as Record<string, unknown>;
  return typeof r.hookType === "string";
}

async function loadObservations(
  kv: StateKV,
  sessionId: string,
): Promise<RawObservation[]> {
  const rows = await kv.list<RawObservation | CompressedObservation>(
    KV.observations(sessionId),
  );
  return rows.map((r) => (isRawShape(r) ? r : rawFromCompressed(r as CompressedObservation)));
}

async function findJsonlFiles(root: string, limit = 200): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    if (out.length >= limit) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (out.length >= limit) return;
      const full = join(dir, name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile() && name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

export function registerReplayFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::replay::load",
    async (data: { sessionId: string }): Promise<
      | { success: true; timeline: Timeline; session: Session | null }
      | { success: false; error: string }
    > => {
      if (!data?.sessionId || typeof data.sessionId !== "string") {
        return { success: false, error: "sessionId is required" };
      }
      const session = await kv.get<Session>(KV.sessions, data.sessionId);
      const observations = await loadObservations(kv, data.sessionId);
      const timeline = projectTimeline(observations);
      return { success: true, timeline, session };
    },
  );

  sdk.registerFunction(
    "mem::replay::sessions",
    async (): Promise<{ success: true; sessions: Session[] }> => {
      const sessions = await kv.list<Session>(KV.sessions);
      sessions.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      return { success: true, sessions };
    },
  );

  sdk.registerFunction(
    "mem::replay::import-jsonl",
    async (
      data: { path?: string; maxFiles?: number } = {},
    ): Promise<
      | {
          success: true;
          imported: number;
          sessionIds: string[];
          observations: number;
        }
      | { success: false; error: string }
    > => {
      const defaultRoot = join(homedir(), ".claude", "projects");
      const rawPath = data.path || defaultRoot;
      if (typeof rawPath !== "string" || rawPath.length === 0) {
        return { success: false, error: "path must be a non-empty string" };
      }
      const expanded = rawPath.startsWith("~")
        ? join(homedir(), rawPath.slice(1))
        : rawPath;
      const abs = resolve(expanded);
      if (isSensitive(abs)) {
        return { success: false, error: "refusing to process sensitive-looking path" };
      }
      if (await isSymlink(abs)) {
        return { success: false, error: "symlinks are not supported" };
      }

      let stat;
      try {
        stat = await lstat(abs);
      } catch {
        return { success: false, error: "path not found" };
      }

      let files: string[] = [];
      if (stat.isDirectory()) {
        files = await findJsonlFiles(abs, data.maxFiles || 200);
      } else if (stat.isFile() && abs.endsWith(".jsonl")) {
        files = [abs];
      } else {
        return { success: false, error: "path must be a .jsonl file or directory" };
      }

      if (files.length === 0) {
        return { success: true, imported: 0, sessionIds: [], observations: 0 };
      }

      const sessionIds: string[] = [];
      let observationCount = 0;

      for (const file of files) {
        if (isSensitive(file)) continue;
        if (await isSymlink(file)) continue;
        let text: string;
        try {
          text = await readFile(file, "utf-8");
        } catch (err) {
          logger.warn("replay: failed to read jsonl", {
            file,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        const parsed = parseJsonlText(text, generateId("sess"));
        if (parsed.observations.length === 0) continue;

        const existing = await kv.get<Session>(KV.sessions, parsed.sessionId);
        if (existing) {
          existing.observationCount =
            (existing.observationCount || 0) + parsed.observations.length;
          if (parsed.endedAt > (existing.endedAt || "")) {
            existing.endedAt = parsed.endedAt;
          }
          if (existing.status === "active") existing.status = "completed";
          const existingTags = existing.tags || [];
          if (!existingTags.includes("jsonl-import")) {
            existing.tags = [...existingTags, "jsonl-import"];
          }
          await kv.set(KV.sessions, existing.id, existing);
        } else {
          const session: Session = {
            id: parsed.sessionId,
            project: parsed.project,
            cwd: parsed.cwd,
            startedAt: parsed.startedAt,
            endedAt: parsed.endedAt,
            status: "completed",
            observationCount: parsed.observations.length,
            tags: ["jsonl-import"],
          };
          await kv.set(KV.sessions, session.id, session);
        }

        await Promise.all(
          parsed.observations.map((obs) =>
            kv.set(KV.observations(parsed.sessionId), obs.id, obs),
          ),
        );
        observationCount += parsed.observations.length;
        sessionIds.push(parsed.sessionId);
      }

      await safeAudit(kv, "import", "mem::replay::import-jsonl", sessionIds, {
        source: "jsonl",
        path: abs,
        files: files.length,
        observations: observationCount,
      });

      return {
        success: true,
        imported: files.length,
        sessionIds,
        observations: observationCount,
      };
    },
  );
}
