import { asc } from "drizzle-orm";
import type { Db } from "./db/client";
import { users, type UserRow } from "./db/schema";
import { toPublicUser } from "./serialize";
import { visibleUserIds } from "@shared/permissions";
import type { PublicUser } from "@shared/types";

export async function loadTeam(db: Db): Promise<UserRow[]> {
  return db.select().from(users).orderBy(asc(users.sortOrder), asc(users.id)).all();
}

export function publicTeam(team: UserRow[], viewer: UserRow): PublicUser[] {
  return team.map((u) => toPublicUser(u, viewer.role === "admin"));
}

export function visibleIdsFor(viewer: UserRow, team: UserRow[]): number[] {
  return visibleUserIds(toPublicUser(viewer, false), team.map((u) => toPublicUser(u, false)));
}
