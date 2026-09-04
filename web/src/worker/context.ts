import type { Context } from "hono";
import type { Env } from "./env";
import type { Db } from "./db/client";
import type { UserRow } from "./db/schema";
import type { PublicUser } from "@shared/types";

export type Vars = {
  db: Db;
  user: UserRow;
  team: UserRow[];
  teamPublic: PublicUser[];
};

export type AppContext = Context<{ Bindings: Env; Variables: Vars }>;

export type AppEnv = { Bindings: Env; Variables: Vars };
