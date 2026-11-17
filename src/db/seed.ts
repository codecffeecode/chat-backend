import { closeDb, db } from "./client.js";
import { users } from "./schema.js";

export const SEED_USERS = [
  { id: "8a6dd9bb-dad9-4bb6-ae9a-dc62d8199a5c", name: "Alice" },
  { id: "df6c34aa-4f2e-43de-81d5-56ad0b94672a", name: "Bob" },
  { id: "43b8e81c-200e-42c4-9f73-67d686377924", name: "Carol" },
  { id: "6c9b7396-4146-4598-9943-ea09562f68ad", name: "Dave" },
  { id: "17ab4077-39ef-422e-b6f3-f94b00e72235", name: "Erin" },
] as const;

await db
  .insert(users)
  .values([...SEED_USERS])
  .onConflictDoNothing({ target: users.id });
await closeDb();
console.log(`seeded ${SEED_USERS.length} users`);
