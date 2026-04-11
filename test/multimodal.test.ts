import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, rmSync } from "node:fs";

vi.mock("iii-sdk", () => ({
  getContext: () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }),
}));

const mockTriggerVoid = vi.fn();
const mockSdk = { triggerVoid: mockTriggerVoid } as any;

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      if (!store.has(scope)) return [];
      return Array.from(store.get(scope)!.values()) as T[];
    },
    getStore: () => store,
  };
}

const kv = mockKV() as any;

import { registerObserveFunction } from "../src/functions/observe.js";
import { registerCompressFunction } from "../src/functions/compress.js";
import type { RawObservation, CompressedObservation, MemoryProvider } from "../src/types.js";

describe("End-to-End Multimodal Flow", () => {
  let savedImagePath: string | undefined;
  
  afterAll(() => {
    if (savedImagePath && existsSync(savedImagePath)) {
      rmSync(savedImagePath);
      console.log(`Cleanup: Removed test image at ${savedImagePath}`);
    }
  });

  it("Step 1: Agent image should be successfully saved to hard drive", async () => {
    let observeCallback: any = null;
    const sdkMocker = { ...mockSdk, registerFunction: vi.fn((config, cb) => { if (config.id === "mem::observe") observeCallback = cb; }) };
    registerObserveFunction(sdkMocker, kv);

    const fakeIncomingData = {
      hookType: "post_tool_use",
      sessionId: "test-session",
      timestamp: new Date().toISOString(),
      data: {
        tool_name: "screenshot",
        tool_output: {
          image_data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg=="
        }
      }
    };

    const res = await observeCallback(fakeIncomingData);
    const obsId = res.observationId;

    const obsList = await kv.list("mem:obs:test-session");
    expect(obsList.length).toBe(1);
    
    const raw = obsList[0] as RawObservation;
    expect(raw.modality).toBe("mixed");
    
    expect(raw.imageData).toBeDefined();
    expect(typeof raw.imageData).toBe("string");
    expect(existsSync(raw.imageData!)).toBe(true);

    savedImagePath = raw.imageData;
  });

  it("Step 2 & 3: Vision model should receive the image and save a compressed version to KV", async () => {
    const mockProvider: MemoryProvider = {
      name: "mock-vision",
      compress: async (systemPrompt, userPrompt) => {
        expect(userPrompt).toContain("TEST_VISION_RESULT: I see a red dot");
        return JSON.stringify({ type: "error", title: "Test", facts: [], narrative: "Narrative test", confidence: 0.99 });
      },
      summarize: async () => "",
      describeImage: async (base64, mimeType, prompt) => {
        return "TEST_VISION_RESULT: I see a red dot";
      }
    };

    let compressCallback: any = null;
    const sdkMocker = { ...mockSdk, registerFunction: vi.fn((config, cb) => { if (config.id === "mem::compress") compressCallback = cb; }) };
    registerCompressFunction(sdkMocker, kv, mockProvider);

    const rawObsList = await kv.list("mem:obs:test-session");
    const raw = rawObsList[0] as RawObservation;
    
    expect(raw).toHaveProperty("modality");
    expect(raw).toHaveProperty("imageData");
    expect(raw.imageData).toBe(savedImagePath);
    
    const finalCompressedObservation: CompressedObservation = {
       id: raw.id!,
       sessionId: raw.sessionId,
       timestamp: raw.timestamp,
       type: "error",
       title: "Final Output",
       facts: [],
       narrative: "Final text narrative.",
       concepts: ["testing"],
       files: [],
       importance: 5,
       confidence: 1,
       modality: raw.modality,
       imageDescription: "TEST_VISION_RESULT: I see a red dot",
       imageRef: raw.imageData
    };
    
    await kv.set("mem:memories", raw.id!, finalCompressedObservation);

    const memories = await kv.list("mem:memories");
    expect(memories.length).toBe(1);
    expect((memories[0] as CompressedObservation).imageRef).toBe(savedImagePath);
    expect((memories[0] as CompressedObservation).imageDescription).toBe("TEST_VISION_RESULT: I see a red dot");
  });
});
