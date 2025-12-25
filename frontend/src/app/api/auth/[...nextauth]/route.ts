import NextAuth, { type NextAuthOptions } from "next-auth";
import AzureADProvider from "next-auth/providers/azure-ad";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";

const REFRESH_THRESHOLD_SECONDS = 60;

type RefreshTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

async function refreshAzureToken(refreshToken: string): Promise<RefreshTokenPayload> {
  const tenantId = process.env.AZURE_AD_TENANT_ID ?? "";
  if (!tenantId) {
    throw new Error("Azure tenant ID not configured");
  }
  const clientId = process.env.AZURE_AD_CLIENT_ID ?? "";
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET ?? "";
  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "openid profile email offline_access",
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error("Failed to refresh Azure token");
  }
  return (await response.json()) as RefreshTokenPayload;
}

async function refreshGoogleToken(refreshToken: string): Promise<RefreshTokenPayload> {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error("Failed to refresh Google token");
  }
  return (await response.json()) as RefreshTokenPayload;
}

async function refreshProviderToken(token: any): Promise<any> {
  if (!token.refreshToken || !token.provider) {
    return token;
  }
  try {
    const payload =
      token.provider === "google"
        ? await refreshGoogleToken(token.refreshToken)
        : await refreshAzureToken(token.refreshToken);
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    return {
      ...token,
      idToken: typeof payload.id_token === "string" ? payload.id_token : token.idToken,
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : token.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      error: undefined,
    };
  } catch {
    return { ...token, error: "RefreshAccessTokenError" };
  }
}

const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "Email",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) {
          return null;
        }
        const backend = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
        const response = await fetch(`${backend}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!response.ok) {
          return null;
        }
        const data = (await response.json()) as {
          access_token?: unknown;
          user?: { id?: unknown; email?: unknown; display_name?: unknown };
        };
        const accessToken = typeof data.access_token === "string" ? data.access_token : null;
        const user = data.user ?? {};
        const userId = typeof user.id === "string" ? user.id : "";
        const userEmail = typeof user.email === "string" ? user.email : email;
        const userName =
          typeof user.display_name === "string" && user.display_name.trim()
            ? user.display_name.trim()
            : userEmail;
        if (!accessToken || !userId) {
          return null;
        }
        return { id: userId, email: userEmail, name: userName, apiToken: accessToken } as any;
      },
    }),
    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID ?? "",
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET ?? "",
      tenantId: process.env.AZURE_AD_TENANT_ID ?? "",
      authorization: {
        params: {
          scope: "openid profile email offline_access",
        },
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, account, user }) {
      if (account?.id_token) {
        token.idToken = account.id_token;
        token.provider = account.provider;
        token.refreshToken = account.refresh_token ?? token.refreshToken;
        token.expiresAt = typeof account.expires_at === "number" ? account.expires_at : token.expiresAt;
        delete token.apiToken;
      }
      const apiToken = (user as any)?.apiToken;
      if (typeof apiToken === "string" && apiToken) {
        token.apiToken = apiToken;
        delete token.provider;
        delete token.refreshToken;
        delete token.expiresAt;
        delete token.error;
        delete token.idToken;
      }
      if (token.apiToken) {
        return token;
      }
      if (token.expiresAt && typeof token.expiresAt === "number") {
        const now = Math.floor(Date.now() / 1000);
        if (now < token.expiresAt - REFRESH_THRESHOLD_SECONDS) {
          return token;
        }
      }
      if (token.refreshToken && token.provider) {
        return await refreshProviderToken(token);
      }
      return token;
    },
    async session({ session, token }) {
      session.idToken = typeof token.idToken === "string" ? token.idToken : undefined;
      session.apiToken = typeof token.apiToken === "string" ? token.apiToken : undefined;
      session.error = typeof token.error === "string" ? token.error : undefined;
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  authOptions.providers?.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
        },
      },
    })
  );
}

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
