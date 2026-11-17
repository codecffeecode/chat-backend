import type { z } from "zod";
import { badRequest } from "../errors.js";

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T extends z.ZodType>(raw: string, schema: T): z.output<T> {
  try {
    const json: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const parsed = schema.safeParse(json);
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    throw badRequest("invalid_cursor", "Cursor is malformed");
  }
  throw badRequest("invalid_cursor", "Cursor is malformed");
}
