import { NextResponse } from "next/server"
import { getPresignedUrl } from "@/lib/r2"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const key = searchParams.get("key")

  if (!key || !key.startsWith("clips/")) {
    return NextResponse.json({ error: "Invalid key" }, { status: 400 })
  }

  try {
    const url = await getPresignedUrl(key)
    return NextResponse.json({ url })
  } catch {
    return NextResponse.json({ error: "Failed to generate URL" }, { status: 500 })
  }
}
