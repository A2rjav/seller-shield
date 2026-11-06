import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { kitDatabaseUrl } from "./src/lib/db/kit-url";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: kitDatabaseUrl(process.argv, process.env) },
});
