import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./client.js";

await migrate(db, { migrationsFolder: "./drizzle" });
await closeDb();
console.log("migrations applied");
