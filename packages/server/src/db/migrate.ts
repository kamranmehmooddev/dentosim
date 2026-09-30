/** Apply migrations (drizzle/*.sql, including row-level security policies). */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./client.js";

export async function runMigrations(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await migrate(db(), { migrationsFolder: resolve(here, "../../drizzle") });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => console.log("migrations applied"))
    .then(closeDb)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
