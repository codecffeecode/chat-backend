import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { inArray, or } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";
import { buildApp } from "../src/create-app.js";
import { env } from "../src/config.js";
import { closeDb, db } from "../src/db/client.js";
import { chatMembers, chats, users } from "../src/db/schema.js";
import { firestore } from "../src/firebase/firestore.js";
import { rawChatRef } from "../src/modules/messages/messages.store.js";
import type { UserDto } from "../src/modules/users/users.service.js";

if (!env.FIRESTORE_EMULATOR_HOST || !env.FIREBASE_PROJECT_ID.startsWith("demo-")) {
  throw new Error("Tests must run against the Firestore emulator with a demo- project id");
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface Harness {
  request: (method: NonNullable<InjectOptions["method"]>, url: string, payload?: object) => Promise<LightMyRequestResponse>;
  user: (name?: string) => Promise<string>;
  users: (count: number) => Promise<string[]>;
}

export function setupHarness(): Harness {
  let app: FastifyInstance | undefined;
  const userIds: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      const memberships = await db
        .selectDistinct({ chatId: chatMembers.chatId })
        .from(chatMembers)
        .where(inArray(chatMembers.userId, userIds));
      const created = await db
        .select({ chatId: chats.id })
        .from(chats)
        .where(inArray(chats.createdBy, userIds));
      const chatIds = [...new Set([...memberships, ...created].map((r) => r.chatId))];

      await Promise.all(chatIds.map((id) => firestore().recursiveDelete(rawChatRef(id))));
      if (chatIds.length > 0) {
        await db.delete(chats).where(or(inArray(chats.id, chatIds), inArray(chats.createdBy, userIds)));
      }
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await app?.close();
    await closeDb();
    await firestore().terminate();
  });

  const request: Harness["request"] = (method, url, payload) => {
    if (!app) {
      throw new Error("app not ready");
    }
    return app.inject(payload === undefined ? { method, url } : { method, url, payload });
  };

  const user: Harness["user"] = async (name) => {
    counter += 1;
    const res = await request("POST", "/users", { name: name ?? `test-user-${counter}` });
    if (res.statusCode !== 201) {
      throw new Error(`failed to create user: ${res.body}`);
    }
    const { userId } = res.json<UserDto>();
    userIds.push(userId);
    return userId;
  };

  const usersFn: Harness["users"] = async (count) => {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(await user());
    }
    return ids;
  };

  return { request, user, users: usersFn };
}

export function errorCode(body: string): string {
  return (JSON.parse(body) as ErrorBody).error.code;
}
