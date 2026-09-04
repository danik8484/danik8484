import { execSync } from "node:child_process";

/** Reset login-code rate limits so repeated local runs never hit the 5-codes-per-hour guard. */
export default function globalSetup() {
  try {
    execSync('npx wrangler d1 execute fitness-daily-tasks --local --command "DELETE FROM login_codes;"', { stdio: "ignore" });
  } catch {
    // The dev server may hold the DB in a different state dir; the tests will surface a clear error.
  }
}
