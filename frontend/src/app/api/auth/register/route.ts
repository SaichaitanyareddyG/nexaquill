import { NextResponse } from "next/server";

export async function POST(request: Request): Promise<Response> {
  const backend = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ detail: "Invalid JSON" }, { status: 400 });
  }

  const response = await fetch(`${backend}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  }
  const text = await response.text();
  return new Response(text, { status: response.status });
}

