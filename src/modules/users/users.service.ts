import { asc, eq, inArray } from "drizzle-orm";
import { db, type Executor } from "../../db/client.js";
import { users, type UserRow } from "../../db/schema.js";
import { notFound } from "../../errors.js";

export interface UserDto {
  userId: string;
  name: string;
  createdAt: string;
}

export function toUserDto(row: UserRow): UserDto {
  return { userId: row.id, name: row.name, createdAt: row.createdAt.toISOString() };
}

export async function createUser(name: string): Promise<UserDto> {
  const [row] = await db.insert(users).values({ name: name.trim() }).returning();
  if (!row) {
    throw new Error("insert returned no row");
  }
  return toUserDto(row);
}

export async function listUsers(): Promise<UserDto[]> {
  const rows = await db.select().from(users).orderBy(asc(users.createdAt), asc(users.id));
  return rows.map(toUserDto);
}

export async function getUser(userId: string, executor: Executor = db): Promise<UserRow> {
  const [row] = await executor.select().from(users).where(eq(users.id, userId));
  if (!row) {
    throw notFound("user_not_found", `User ${userId} does not exist`);
  }
  return row;
}

export async function assertUsersExist(userIds: readonly string[], executor: Executor = db): Promise<void> {
  const unique = [...new Set(userIds)];
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, unique));
  const found = new Set(rows.map((r) => r.id));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw notFound(
      "user_not_found",
      missing.length === 1
        ? `User ${missing[0] ?? ""} does not exist`
        : `Users ${missing.join(", ")} do not exist`,
    );
  }
}
