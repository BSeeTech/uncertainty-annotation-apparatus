/**
 * Minimal 3-component vector implementation.
 * Replaces the cornerstone-math Vector3 dependency to eliminate Cornerstone V1 traces
 * while preserving full compatibility with the Cornerstone3D V2-only codebase.
 */
export class Vector3 {
  constructor(
    public x: number,
    public y: number,
    public z: number
  ) {}

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  sub(v: Vector3): Vector3 {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  dot(v: Vector3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vector3): Vector3 {
    const ax = this.x, ay = this.y, az = this.z;
    const bx = v.x, by = v.y, bz = v.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  divideScalar(s: number): Vector3 {
    this.x /= s;
    this.y /= s;
    this.z /= s;
    return this;
  }
}
