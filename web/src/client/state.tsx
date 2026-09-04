import { createContext, useContext } from "react";
import type { MeResponse, PublicUser } from "@shared/types";

export interface Session extends MeResponse {
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  userById: (id: number) => PublicUser | undefined;
  nameOf: (id: number | null | undefined) => string;
  canSee: (userId: number) => boolean;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("no session");
  return s;
}
