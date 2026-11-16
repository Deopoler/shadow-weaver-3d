/*
 * Chiaroscuro: Shadow Weaver — stage data.
 *
 * platforms : axis-aligned floor rectangles (top surface at y = 0)
 * light     : the weaver's lamp, orbiting `pivot` at `radius`; theta0 in degrees
 * occluders : hexahedra. pos = centre, size = [x, y, z], taper = top-ring scale,
 *             bob = vertical oscillation, solid = stands on the floor and blocks the player
 * mirror    : vertical reflective plane; normal = horizontal unit vector [nx, nz] pointing to its front
 * sentinels : red watcher spotlights. mode 'orbit' (aim circles a centre) or 'sweep' (aim swings a↔b)
 */
(function (root) {
  'use strict';
  var SW = root.SW = root.SW || {};

  SW.STAGES = [
    /* ---------------------------------------------------------------- */
    {
      id: 1,
      name: '그림자의 길',
      en: 'THE SHADOW PATH',
      hint: 'Q / E 또는 드래그로 광원을 돌려, 떠 있는 기둥의 그림자를 낭떠러지 위에 드리우세요. 그림자는 밟을 수 있습니다.',
      start: [-12, 0],
      portal: [14.5, 0],
      platforms: [
        { x0: -15, x1: -3, z0: -4.5, z1: 4.5, spawn: [-12, 0] },
        { x0: 3, x1: 17, z0: -4.5, z1: 4.5, spawn: [4.6, 0] }
      ],
      light: { pivot: [0, 0], radius: 7, height: 10, minH: 9, maxH: 12.5, theta0: 75 },
      occluders: [
        { kind: 'obelisk', pos: [-4.1, 4.9, 0], size: [1.6, 4.2, 1.6], taper: 0.6 },
        { kind: 'pillar', pos: [10.2, 0.9, 1.9], size: [1.3, 1.8, 1.3], solid: true }
      ],
      sentinels: [
        { pos: [12, 11, -7], mode: 'orbit', center: [10.8, 0], radius: 2.6, period: 8, phase: 0.1, cone: 11 }
      ]
    },

    /* ---------------------------------------------------------------- */
    {
      id: 2,
      name: '교차와 은신',
      en: 'CROSSING & CONCEALMENT',
      hint: '두 블록의 그림자를 징검다리 삼아 건너세요(틈은 Space로 점프). 중앙 섬에 닿으면 광원을 다시 돌려 다음 다리를 이으세요.',
      start: [-22, 0],
      portal: [-3, -20],
      platforms: [
        { x0: -25, x1: -16, z0: -4, z1: 4, spawn: [-22, 0] },
        { x0: -5, x1: 5, z0: -5, z1: 5, spawn: [-3.8, 1.4] },
        { x0: -11, x1: -1, z0: -22, z1: -12.2, spawn: [-5.5, -13.6] }
      ],
      light: { pivot: [0, 0], radius: 6, height: 10, minH: 9, maxH: 12.5, theta0: 215 },
      occluders: [
        { kind: 'slab', pos: [-0.85, 5, 0], size: [2.9, 0.4, 1.8] },
        { kind: 'slab', pos: [-2.16, 6, 0], size: [2.2, 0.4, 1.6] },
        { kind: 'pillar', pos: [2.2, 0.9, -1.0], size: [1.3, 1.8, 1.3], solid: true },
        { kind: 'pillar', pos: [-4.6, 0.9, -15.4], size: [1.3, 1.8, 1.3], solid: true }
      ],
      sentinels: [
        { pos: [8, 11, 3], mode: 'sweep', a: [-3.6, -3.6], b: [3.8, -3.4], period: 7, phase: 0.5, cone: 9 },
        { pos: [-13, 11, -13], mode: 'orbit', center: [-7, -18.6], radius: 2.2, period: 9, phase: 0.3, cone: 9 }
      ]
    },

    /* ---------------------------------------------------------------- */
    {
      id: 3,
      name: '거울과 부유석',
      en: 'MIRROR & THE DRIFTING STONE',
      hint: '광원이 거울을 비추면 반사광(2차 광원)이 생깁니다. 오르내리는 블록의 그림자가 건너편에 닿는 순간을 노리세요.',
      start: [-13, 8],
      portal: [-13.5, -8],
      platforms: [
        { x0: -16, x1: -4, z0: 4, z1: 12, spawn: [-13, 8] },
        { x0: 3, x1: 15, z0: -12, z1: 12, spawn: [4.6, 8] },
        { x0: -16, x1: -4, z0: -12, z1: -4, spawn: [-5.4, -8] }
      ],
      light: { pivot: [0, 0], radius: 12, height: 10, minH: 9, maxH: 12.5, theta0: 60 },
      occluders: [
        { kind: 'slab', pos: [-4.75, 5, 8], size: [3.8, 0.4, 1.8] },
        { kind: 'drifter', pos: [8, 4.15, -8], size: [4, 0.5, 2.2], bob: { amp: 0.85, period: 7, phase: 0 } },
        { kind: 'pillar', pos: [6.6, 0.9, 2.4], size: [1.4, 1.8, 1.4], solid: true }
      ],
      mirror: { center: [14.6, 5.25, -8], normal: [-1, 0], width: 6.5, height: 10.5 },
      sentinels: [
        { pos: [9, 12, 3], mode: 'sweep', a: [4.6, 0.6], b: [13, -0.6], period: 6.5, phase: 0, cone: 11 },
        { pos: [-11, 11, -15], mode: 'orbit', center: [-11.4, -8], radius: 2.1, period: 8, phase: 0.5, cone: 10 }
      ]
    }
  ];

  if (typeof module !== 'undefined' && module.exports) module.exports = SW;
})(typeof globalThis !== 'undefined' ? globalThis : this);
