import { NextResponse } from "next/server";
import { MissingApiKeyError, extractFromFile } from "@/lib/extract";

export const runtime = "nodejs";
export const maxDuration = 120;

const ACCEPTED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Falta el fichero." }, { status: 400 });
  }
  if (!ACCEPTED.has(file.type)) {
    return NextResponse.json(
      { error: `Tipo no soportado: ${file.type || "desconocido"}. Usa PDF, JPEG, PNG o WebP.` },
      { status: 415 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await extractFromFile(buffer, file.type);
    return NextResponse.json({
      method: result.method,
      data: result.data,
      filename: file.name,
      sizeBytes: buffer.byteLength,
    });
  } catch (error) {
    // Only messages we authored reach the client. Upstream SDK/network errors are logged
    // server-side and replaced with a generic message so internals are never exposed.
    if (error instanceof MissingApiKeyError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error("[extract] extraction failed:", error);
    return NextResponse.json(
      { error: "No se pudo leer el informe. Inténtalo de nuevo o introduce los datos a mano." },
      { status: 502 },
    );
  }
}
