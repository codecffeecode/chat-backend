import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

export type ErrorCode =
  | "bad_request"
  | "validation_error"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "internal_error";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const notFound = (code: string, message: string) => new AppError(404, code, message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

function body(code: string, message: string, details?: unknown): ErrorBody {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .status(404)
      .send(body("route_not_found", `Route ${request.method} ${request.url} not found`));
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(body(error.code, error.message, error.details));
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((issue) => ({
        path: issue.instancePath.replace(/^\//, "").replaceAll("/", "."),
        message: issue.message,
      }));
      const first = details[0];
      const message = first
        ? `${error.validationContext ?? "request"}${first.path ? `.${first.path}` : ""}: ${first.message}`
        : "Invalid request";
      return reply.status(400).send(body("validation_error", message, details));
    }

    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send(body(error.code.toLowerCase(), error.message));
    }

    request.log.error({ err: error }, "unhandled error");
    return reply.status(500).send(body("internal_error", "Something went wrong"));
  });
}
