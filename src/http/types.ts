import type { Db } from '../db/connection.ts';
import type { StaffUser } from '../services/auth.ts';

export type AppEnv = {
  Variables: {
    db: Db;
    staff?: StaffUser;
    /** Namn som loggas i orderhändelser ("system", "api" eller personalens namn). */
    actor: string;
  };
};
