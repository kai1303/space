type ImageSize = { width: number; height: number };
export type GalleryTile = ImageSize & { crop: boolean; overflow: number };

function heightLimit(width: number, image: ImageSize) {
  // The media gallery allows taller previews for portraits and squares.
  const limits = width >= 636 ? [235, 354, 314] : width >= 472 ? [154, 276, 206]
    : width >= 448 ? [115, 206, 206] : [115, 206, 154];
  return limits[image.width > image.height ? 0 : image.width < image.height ? 1 : 2]!;
}

export function imageGalleryLayout(images: ImageSize[], width: number): GalleryTile[] {
  const limit = width >= 600 ? 4 : width >= 448 ? 3 : width >= 224 ? 2 : 1;
  const visible = images.slice(0, limit);
  if (!visible.length) return [];
  const available = Math.max(1, width - 8 * (visible.length - 1));
  let sizes: ImageSize[];
  if (visible.length <= 2) {
    const tallest = visible.reduce((a, b) => a.height >= b.height ? a : b);
    const maxHeight = heightLimit(width, tallest);
    const floor = Math.min(108, available / visible.length);
    const extra = visible.map(image => Math.max(0, Math.min(image.width, maxHeight * image.width / image.height) - floor));
    const total = extra.reduce((sum, n) => sum + n, 0);
    const scale = total ? Math.min(1, (available - floor * visible.length) / total) : 0;
    const widths = extra.map(value => Math.floor(floor + value * scale));
    const height = Math.max(floor, ...visible.map((image, i) => Math.min(image.height, maxHeight, widths[i]! * image.height / image.width)));
    sizes = widths.map(width => ({ width, height }));
  } else {
    const ratios = visible.map(image => image.width > image.height ? 4 / 3 : image.width < image.height ? 3 / 4 : 1);
    const height = available / ratios.reduce((sum, ratio) => sum + ratio, 0);
    sizes = ratios.map(ratio => ({ width: Math.floor(height * ratio), height }));
  }
  return sizes.map((size, i) => ({
    ...size, crop: visible.length > 2 && Math.min(visible[i]!.width, visible[i]!.height) >= 100,
    overflow: i === sizes.length - 1 && images.length > sizes.length ? images.length - i : 0,
  }));
}
