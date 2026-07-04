export class VehiclePhysics {
  private static readonly delta = 4.0;
  static calculateAcceleration(v: number, s: number, dv: number, v0: number, T: number, a: number, b: number, s0: number): number {
    const safeV0 = Math.max(v0, 0.01);
    const safeS = Math.max(s, 0.1);
    const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
    return a * (1 - Math.pow(v / safeV0, this.delta) - Math.pow(sStar / safeS, 2));
  }
  static getSafeDistance(v: number, T: number = 1.0, s0: number = 2.0): number { return s0 + v * T; }
}
