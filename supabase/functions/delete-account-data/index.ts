import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLERK_ISSUER = Deno.env.get("CLERK_ISSUER") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(issuer: string) {
  let set = jwksCache.get(issuer);
  if (!set) {
    set = createRemoteJWKSet(
      new URL(`${issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
    );
    jwksCache.set(issuer, set);
  }
  return set;
}

async function verifyClerkUser(
  authHeader: string | null,
): Promise<string | null> {
  // This endpoint is destructive. Never trust an issuer supplied by the
  // unverified token itself; refuse requests if the project secret is absent.
  if (!CLERK_ISSUER || !authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  try {
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(
      atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")),
    );
    if (payload.iss !== CLERK_ISSUER) return null;
    const { payload: verified } = await jwtVerify(token, jwksFor(CLERK_ISSUER), {
      issuer: CLERK_ISSUER,
    });
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      verified.act != null ||
      typeof verified.iat !== "number" ||
      verified.iat < nowSeconds - 10 * 60 ||
      verified.iat > nowSeconds + 60
    ) {
      return null;
    }
    return typeof verified.sub === "string" ? verified.sub : null;
  } catch {
    return null;
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

async function removeStoragePrefix(bucket: string, prefix: string): Promise<boolean> {
  const limit = 100;

  while (true) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit,
      // Always start at zero. Removing each page as we go prevents a large
      // account from building one huge in-memory filename list or timing out
      // before any progress is committed.
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      const message = error.message.toLowerCase();
      if (message.includes("bucket") && message.includes("not found")) {
        return false;
      }
      throw error;
    }

    const entries = data ?? [];
    if (!entries.length) return true;

    const files: string[] = [];
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) {
        files.push(path);
      } else {
        await removeStoragePrefix(bucket, path);
      }
    }
    if (files.length) {
      const { error: removeError } = await admin.storage.from(bucket).remove(files);
      if (removeError) throw removeError;
    }
  }
}

async function removeUserStorage(userId: string) {
  const userPrefix = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  for (const bucket of ["clothing-images", "body-photos"]) {
    await removeStoragePrefix(bucket, userPrefix);
  }
}

function isMissingOptionalTable(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

async function deleteByUser(table: string, userId: string) {
  const { error } = await admin.from(table).delete().eq("user_id", userId);
  // Optional tables may not exist on an older environment. Everything present
  // in the active schema is still deleted; other database errors are fatal.
  if (error && !isMissingOptionalTable(error)) throw error;
}

async function selectAllUserIds(table: string, userId: string): Promise<string[]> {
  const ids: string[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await admin
      .from(table)
      .select("id")
      .eq("user_id", userId)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    ids.push(...page.map((row) => String(row.id)));
    if (page.length < pageSize) return ids;
  }
}

async function deleteUserRows(userId: string) {
  // Stop future automation work and remove the profile first. The worker uses
  // profile existence as its account-active guard, so an already-running job
  // will stop before its next persistent write.
  await deleteByUser("autogen_schedules", userId);
  await deleteByUser("push_tokens", userId);
  await deleteByUser("profiles", userId);

  const [outfitIds, wardrobeIds] = await Promise.all([
    selectAllUserIds("outfits", userId),
    selectAllUserIds("wardrobes", userId),
  ]);

  for (const table of [
    "day_entries",
    "outfit_schedule",
    "wear_history",
    "generation_history",
    "stylist_generation_items",
    "generation_usage_daily",
    "generation_usage_meta",
    "enhancement_usage_daily",
  ]) {
    await deleteByUser(table, userId);
  }

  for (const batch of chunks(outfitIds, 250)) {
    const { error } = await admin.from("outfit_items").delete().in("outfit_id", batch);
    if (error) throw error;
  }
  for (const batch of chunks(wardrobeIds, 250)) {
    const { error } = await admin
      .from("wardrobe_items")
      .delete()
      .in("wardrobe_id", batch);
    if (error) throw error;
  }

  for (const table of ["wardrobes", "trips", "outfits", "clothing_items"]) {
    await deleteByUser(table, userId);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const userId = await verifyClerkUser(request.headers.get("Authorization"));
  if (!userId) return json({ error: "Unauthorized" }, 401);

  try {
    const body = await request.json().catch(() => ({}));
    if (body?.confirmation !== "DELETE") {
      return json({ error: "Deletion confirmation is required" }, 400);
    }

    await deleteUserRows(userId);
    await removeUserStorage(userId);
    // A second idempotent sweep closes the window for a generation that was
    // already in flight when the profile/account-active marker disappeared.
    await deleteUserRows(userId);
    await removeUserStorage(userId);
    return json({ ok: true });
  } catch (error) {
    console.error("[delete-account-data]", error);
    return json({ error: "Account data deletion failed" }, 500);
  }
});
