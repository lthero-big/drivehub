import { createContext, useContext } from "react";
import type { AuthStatus, Me } from "./api";

export type AppCtx = {
  status: AuthStatus;
  me: Me | null;
  isAdmin: boolean;
  reload: () => void;
  openPalette: () => void;
  /** Bumped after uploads / file ops so open listings refresh. */
  fsVersion: number;
  bumpFs: () => void;
};

export const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => useContext(Ctx)!;
