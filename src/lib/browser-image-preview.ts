function isHeic(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return file.type === "image/heic" || file.type === "image/heif" || extension === "heic" || extension === "heif";
}

/** Returns a browser-decodable preview without changing the immutable upload File. */
export async function browserImagePreview(file: File): Promise<Blob> {
  if (!isHeic(file)) return file;
  const { default: convertHeic } = await import("heic-convert/browser");
  const jpeg = await convertHeic({
    buffer: new Uint8Array(await file.arrayBuffer()),
    format: "JPEG",
    quality: 0.9,
  });
  return new Blob([Uint8Array.from(jpeg)], { type: "image/jpeg" });
}
