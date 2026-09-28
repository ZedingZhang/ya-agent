export interface WindowGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

export function initialWindowGeometry(screenWidth: number, screenHeight: number): WindowGeometry {
  const width = Math.max(1_020, Math.min(1_900, Math.round(screenWidth * 0.92)));
  const height = Math.max(680, Math.min(1_180, Math.round(screenHeight * 0.9)));
  return {
    width,
    height,
    x: Math.max(0, Math.floor((screenWidth - width) / 2)),
    y: Math.max(0, Math.floor((screenHeight - height) / 2)),
  };
}

/**
 * Mirrors the `.workbench` grid in `styles.css`: the file panel is twice as wide as it used to be
 * (a 380px minimum against the former 190px) and the center and context columns keep their floors,
 * so a window narrower than the three columns need leans on the center column's minimum.
 */
export function initialWorkbenchColumns(width: number): [number, number, number] {
  if (width >= 1_400) return [20, 65, 15];
  const center = width > 1_180 ? 570 : 560;
  return [380, Math.max(center, width - 380 - 260), 260];
}
