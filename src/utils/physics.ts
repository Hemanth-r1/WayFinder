export class VehiclePhysics {
  private static readonly delta = 4.0;

  static calculateAcceleration(
    v: number,
    s: number,
    dv: number,
    v0: number,
    T: number,
    a: number,
    b: number,
    s0: number,
  ): number {
    const sStar = s0 + Math.max(0, v * T + (v * dv) / (2 * Math.sqrt(a * b)));
    const accel = a * (1 - Math.pow(v / v0, this.delta) - Math.pow(sStar / s, 2));
    return accel;
  }

  static getSafeDistance(v: number, T: number = 1.0, s0: number = 2.0): number {
    return s0 + v * T;
  }
}
