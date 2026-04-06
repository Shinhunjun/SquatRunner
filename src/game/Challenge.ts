export class Challenge {
  constructor(
    public lane: number,
    public x: number,
    public width: number,
  ) {}

  scroll(dx: number) { this.x -= dx; }

  get xEnd() { return this.x + this.width; }
  get offScreen() { return this.xEnd < -60; }

  blocks(lane: number, px: number) {
    return lane === this.lane && this.x - 4 <= px && px <= this.xEnd + 4;
  }
}
