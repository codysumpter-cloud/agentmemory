import type { ISdk } from "iii-sdk";
import { getContext } from "iii-sdk";
import type { RawObservation, HookPayload, Session } from "../types.js";
import { KV, STREAM, generateId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { stripPrivateData } from "./privacy.js";
import { DedupMap } from "./dedup.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export function extractImage(d: unknown): string | undefined {
  if (!d) return undefined;
  if (typeof d === "string") {
    if (d.startsWith("data:image/") || d.startsWith("iVBORw0KGgo") || d.startsWith("/9j/")) {
      return d;
    }
    return undefined;
  }
  if (typeof d === "object" && d !== null) {
    const obj = d as Record<string, unknown>;
    if (typeof obj["image_data"] === "string") return obj["image_data"];
    if (typeof obj["image_path"] === "string") return obj["image_path"];
    if (typeof obj["imageBase64"] === "string") return obj["imageBase64"];
    if (typeof obj["imagePath"] === "string") return obj["imagePath"];
    
    for (const key of Object.keys(obj)) {
      const match = extractImage(obj[key]);
      if (match) return match;
    }
  }
  return undefined;
}

export function registerObserveFunction(
  sdk: ISdk,
  kv: StateKV,
  dedupMap?: DedupMap,
  maxObservationsPerSession?: number,
): void {
  sdk.registerFunction(
    {
      id: "mem::observe",
      description: "Capture and store a tool-use observation",
    },
    async (payload: HookPayload) => {
      const ctx = getContext();

      if (
        !payload?.sessionId ||
        typeof payload.sessionId !== "string" ||
        !payload.hookType ||
        typeof payload.hookType !== "string" ||
        !payload.timestamp ||
        typeof payload.timestamp !== "string"
      ) {
        return {
          success: false,
          error:
            "Invalid payload: sessionId, hookType, and timestamp are required",
        };
      }

      const obsId = generateId("obs");

      let dedupHash: string | undefined;
      if (dedupMap) {
        const d =
          typeof payload.data === "object" && payload.data !== null
            ? (payload.data as Record<string, unknown>)
            : {};
        const toolName = (d["tool_name"] as string) || payload.hookType;
        dedupHash = dedupMap.computeHash(
          payload.sessionId,
          toolName,
          d["tool_input"],
        );
        if (dedupMap.isDuplicate(dedupHash)) {
          return { deduplicated: true, sessionId: payload.sessionId };
        }
      }

      let sanitizedRaw: unknown = payload.data;
      try {
        const jsonStr = JSON.stringify(payload.data);
        const sanitized = stripPrivateData(jsonStr);
        sanitizedRaw = JSON.parse(sanitized);
      } catch {
        sanitizedRaw = stripPrivateData(String(payload.data));
      }

      const raw: RawObservation = {
        id: obsId,
        sessionId: payload.sessionId,
        timestamp: payload.timestamp,
        hookType: payload.hookType,
        raw: sanitizedRaw,
      };

      if (typeof sanitizedRaw === "object" && sanitizedRaw !== null) {
        const d = sanitizedRaw as Record<string, unknown>;
        if (
          payload.hookType === "post_tool_use" ||
          payload.hookType === "post_tool_failure"
        ) {
          raw.toolName = d["tool_name"] as string | undefined;
          raw.toolInput = d["tool_input"];
          raw.toolOutput = d["tool_output"] || d["error"];
        }
        if (payload.hookType === "prompt_submit") {
          raw.userPrompt = d["prompt"] as string | undefined;
        }

        const hiddenImage = extractImage(sanitizedRaw);
        if (hiddenImage) {
          raw.modality = (raw.toolInput || raw.toolOutput || raw.userPrompt) ? "mixed" : "image";
          
          if (hiddenImage.startsWith("data:image/") || hiddenImage.startsWith("iVBORw0KGgo") || hiddenImage.startsWith("/9j/")) {
            const { saveImageToDisk } = await import("../utils/image-store.js");
            raw.imageData = saveImageToDisk(hiddenImage);
          } else {
            raw.imageData = hiddenImage;
          }
        }
      }

      return withKeyedLock(`obs:${payload.sessionId}`, async () => {
        if (maxObservationsPerSession && maxObservationsPerSession > 0) {
          const existing = await kv.list(KV.observations(payload.sessionId));
          if (existing.length >= maxObservationsPerSession) {
            return {
              success: false,
              error: `Session observation limit reached (${maxObservationsPerSession})`,
            };
          }
        }

        await kv.set(KV.observations(payload.sessionId), obsId, raw);

        if (dedupMap && dedupHash) {
          dedupMap.record(dedupHash);
        }

        sdk.triggerVoid("stream::set", {
          stream_name: STREAM.name,
          group_id: STREAM.group(payload.sessionId),
          item_id: obsId,
          data: { type: "raw", observation: raw },
        });

        sdk.triggerVoid("stream::set", {
          stream_name: STREAM.name,
          group_id: STREAM.viewerGroup,
          item_id: obsId,
          data: { type: "raw", observation: raw, sessionId: payload.sessionId },
        });

        const session = await kv.get<Session>(KV.sessions, payload.sessionId);
        if (session) {
          await kv.set(KV.sessions, payload.sessionId, {
            ...session,
            observationCount: (session.observationCount || 0) + 1,
          });
        }

        sdk.triggerVoid("mem::compress", {
          observationId: obsId,
          sessionId: payload.sessionId,
          raw,
        });

        ctx.logger.info("Observation captured", {
          obsId,
          sessionId: payload.sessionId,
          hook: payload.hookType,
        });
        return { observationId: obsId };
      });
    },
  );
}
