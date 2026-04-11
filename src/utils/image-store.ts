import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const IMAGES_DIR = join(homedir(), ".agentmemory", "images");

export function saveImageToDisk(base64Data: string): string {
  if (!base64Data) return "";
  mkdirSync(IMAGES_DIR, { recursive: true });
  
  let cleanBase64 = base64Data;
  let ext = "png";
  
  if (base64Data.startsWith("data:image/")) {
     const commaIdx = base64Data.indexOf(",");
     if (commaIdx !== -1) {
       const meta = base64Data.substring(0, commaIdx);
       if (meta.includes("jpeg") || meta.includes("jpg")) ext = "jpg";
       else if (meta.includes("webp")) ext = "webp";
       else if (meta.includes("gif")) ext = "gif";
       cleanBase64 = base64Data.substring(commaIdx + 1);
     }
  } else if (base64Data.startsWith("/9j/")) {
     ext = "jpg";
  }

  const hash = createHash("sha256").update(cleanBase64).digest("hex");
  const filePath = join(IMAGES_DIR, `${hash}.${ext}`);
  
  writeFileSync(filePath, Buffer.from(cleanBase64, "base64"));
  return filePath;
}

export function deleteImage(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    const { existsSync, unlinkSync } = require("node:fs");
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err) {
    console.error("[agentmemory] Failed to delete image context:", err);
  }
}

