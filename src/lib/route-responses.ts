const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export function downloadResponse(
  download: { bytes: Uint8Array; fileName: string; mediaType: string },
  extraHeaders: HeadersInit = {},
): Response {
  const fileName = download.fileName.replace(/["\r\n]/g, "_");
  return new Response(Uint8Array.from(download.bytes).buffer, {
    headers: {
      ...PRIVATE_RESPONSE_HEADERS,
      "Content-Type": download.mediaType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

export function refusalResponse(
  error: string,
  options: { status?: number; message?: string } = {},
): Response {
  return Response.json(
    options.message === undefined ? { error } : { error, message: options.message },
    {
      status: options.status ?? (error === "forbidden" ? 404 : 422),
      headers: PRIVATE_RESPONSE_HEADERS,
    },
  );
}

export function successfulCommandResponse(): Response {
  return new Response(null, { status: 204, headers: PRIVATE_RESPONSE_HEADERS });
}
