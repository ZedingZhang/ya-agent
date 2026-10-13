export interface WindowGeometry {
  width: number;
  height: number;
  x: number;
  y: number;
}

export function initialWindowGeometry(screenWidth: number, screenHeight: number): WindowGeometry {
  const width = Math.max(860, Math.min(1_900, Math.round(screenWidth * 0.92)));
  const height = Math.max(680, Math.min(1_180, Math.round(screenHeight * 0.9)));
  return {
    width,
    height,
    x: Math.max(0, Math.floor((screenWidth - width) / 2)),
    y: Math.max(0, Math.floor((screenHeight - height) / 2)),
  };
}
