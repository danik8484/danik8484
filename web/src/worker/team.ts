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
  const visible = new Set(visibleIdsFor(viewer, team));
  return team.map((u) => {
    const pu = toPublicUser(u, viewer.role === "admin");
    // Teammates outside my view: name, role and active flag only (needed for the cards and name tags)
    return viewer.role === "admin" || visible.has(u.id) ? pu : { ...pu, managerId: null };
  });
}

export function visibleIdsFor(viewer: UserRow, team: UserRow[]): number[] {
  return visibleUserIds(toPublicUser(viewer, false), team.map((u) => toPublicUser(u, false)));
}
