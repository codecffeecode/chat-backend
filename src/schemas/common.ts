import { z } from "zod";

export const Id = z.uuid().describe("UUID");

export const IdInput = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.uuid())
  .meta({ format: "uuid", description: "UUID (case-insensitive)" });

export const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export const errorResponses = {
  400: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
} as const;

export const Limit = (defaultValue: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(defaultValue);

export const IsoDate = z.iso.datetime();
