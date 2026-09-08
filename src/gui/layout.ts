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

export function initialWorkbenchColumns(width: number): [number, number, number] {
  if (width >= 1_400) return [10, 75, 15];
  const left = Math.max(190, Math.min(260, Math.round(width * 0.1)));
  const right = Math.max(260, Math.min(300, Math.round(width * 0.2)));
  return [left, Math.max(570, width - left - right), right];
}
