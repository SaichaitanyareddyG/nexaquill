import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    idToken?: string;
    apiToken?: string;
    error?: string;
    user?: DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    idToken?: string;
    apiToken?: string;
    provider?: string;
    refreshToken?: string;
    expiresAt?: number;
    error?: string;
  }
}
