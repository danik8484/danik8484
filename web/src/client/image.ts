/** Downscale a photo on the device before upload (max 1600px edge, JPEG). */
export async function prepareImage(file: File): Promise<{ blob: Blob; width: number; height: number; name: string }> {
  const MAX = 1600;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Unsupported format for decoding (e.g. HEIC on some browsers): send as-is if small enough
    if (file.size <= 2_500_000) return { blob: file, width: 0, height: 0, name: file.name };
    throw new Error("לא הצלחתי לקרוא את התמונה. נסה לצלם ב-JPG.");
  }
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("הדפדפן לא תומך בעיבוד תמונות");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  if (!blob) throw new Error("שגיאה בהקטנת התמונה");
  const base = file.name.replace(/\.[^.]+$/, "") || "photo";
  return { blob, width: w, height: h, name: `${base}.jpg` };
}

/** Small square-ish preview (max 320px) for grids; returns null when the browser cannot decode the image. */
export async function makeThumb(blob: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.75));
  } catch {
    return null;
  }
}
