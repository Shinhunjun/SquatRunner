export const W = 1280;
export const H = 720;
export const CAM_W = 400;
export const GAME_X = CAM_W;
export const GAME_W = W - CAM_W; // 880

export const LANE_FLOOR_Y = [175, 375, 565] as const;
export const PLATFORM_H = 20;
export const PLAYER_H = 60;
export const PLAYER_W = 40;
export const PLAYER_SCREEN_X = [130, 185, 240, 295] as const; // P1~P4

export const LANE_COLORS = [
  '#32d250', // 초록 (서있기)
  '#32a8c8', // 시안 (반스쿼트)
  '#eb3b24', // 빨강 (풀스쿼트)
] as const;

export const SCROLL_SPEED_INIT = 160;
export const SCROLL_SPEED_MAX  = 420;
export const SCROLL_ACCEL      = 8;

export const GAP_MIN_W     = 130;
export const GAP_MAX_W     = 230;
export const SAFE_ZONE_MIN = 420;
export const SAFE_ZONE_MAX = 680;

export const INVINCIBLE_DUR   = 2.0;
export const MAX_LIVES        = 3;
export const MEAT_PER_LIFE    = 30;
export const LANE_THRESHOLDS: [number, number] = [0.55, 0.88];
export const EMA_ALPHA        = 0.45;
export const CALIB_FRAMES     = 70;

// MediaPipe landmark indices
export const LM_RIGHT_HIP   = 24;
export const LM_RIGHT_KNEE  = 26;
export const LM_RIGHT_ANKLE = 28;

export const POSE_CONNECTIONS: [number, number][] = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],
  [9,10],[11,12],[11,13],[13,15],[15,17],[15,19],[17,19],
  [12,14],[14,16],[16,18],[16,20],[18,20],
  [11,23],[12,24],[23,24],[23,25],[25,27],[27,29],[27,31],[29,31],
  [24,26],[26,28],[28,30],[28,32],[30,32],
];
