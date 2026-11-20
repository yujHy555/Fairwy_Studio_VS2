export interface KyalamiHoleHotspot {
  topPct: number;
  leftPct: number;
  widthPct: number;
  heightPct: number;
}

export interface KyalamiHoleGuide {
  number: number;
  par: 3 | 4 | 5;
  strokeIndex: number;
  distances: {
    yellow: number;
    white: number;
    blue: number;
    red: number;
  };
  proTip: string;
  imageUrl: string;
  distanceGuideUrl: string;
  hotspot: KyalamiHoleHotspot;
  mapngCropHint: {
    cropCenterX: number;
    cropCenterZ: number;
    rotationDeg: number;
  };
}

export interface CourseGuideData {
  id: string;
  name: string;
  shortName: string;
  location: string;
  parTotal: number;
  totals: {
    yellow: number;
    white: number;
    blue: number;
    red: number;
  };
  layoutImageUrl: string;
  miniLayoutImageUrl: string;
  logoUrl: string;
  pinBeaconUrl: string;
  sourceUrl: string;
  gpsCenter: {
    lat: number;
    lon: number;
  };
  holes: KyalamiHoleGuide[];
}

/**
 * Exact 17-point polygon boundary enclosing all 18 holes of Kyalami Country Club
 * within the 2048m x 2048m Lipizzaner Road MapNG grid (East meters from West edge, South meters from North edge).
 * Excludes ~74% surrounding urban roads, houses, and polo fields from 3D terrain geometry.
 */
export const KYALAMI_COURSE_BOUNDARY_METERS: { x: number; z: number }[] = [
  { x: 590, z: 795 },
  { x: 1175, z: 795 },
  { x: 1255, z: 595 },
  { x: 1475, z: 585 },
  { x: 1565, z: 675 },
  { x: 1345, z: 985 },
  { x: 1525, z: 1125 },
  { x: 1755, z: 1290 },
  { x: 1795, z: 1410 },
  { x: 1735, z: 1505 },
  { x: 1480, z: 1480 },
  { x: 1090, z: 1415 },
  { x: 895, z: 1395 },
  { x: 425, z: 1330 },
  { x: 390, z: 1195 },
  { x: 455, z: 995 },
  { x: 530, z: 855 }
];

function makeCropHint(leftPct: number, topPct: number, rotationDeg: number) {
  return {
    cropCenterX: Math.round(300 + (leftPct / 100) * 1540),
    cropCenterZ: Math.round(580 + (topPct / 100) * 990),
    rotationDeg
  };
}

export const KYALAMI_COURSE_GUIDE: CourseGuideData = {
  id: 'kyalami',
  name: 'Kyalami Country Club',
  shortName: 'Kyalami GC',
  location: 'Kyalami, Midrand, South Africa',
  parTotal: 72,
  totals: {
    yellow: 6631,
    white: 6369,
    blue: 5761,
    red: 5334
  },
  layoutImageUrl: '/courses/kyalami/images/courseLayout.webp',
  miniLayoutImageUrl: '/courses/kyalami/images/courselayoutsml.webp',
  logoUrl: '/courses/kyalami/images/gcl.webp',
  pinBeaconUrl: '/courses/kyalami/images/location.gif',
  sourceUrl: 'https://www.ecaddy.co.za/gcl/courses/kyalami/',
  gpsCenter: {
    lat: -25.975407,
    lon: 28.058975
  },
  holes: [
    {
      number: 1,
      par: 4,
      strokeIndex: 11,
      distances: { yellow: 343, white: 338, blue: 310, red: 281 },
      proTip:
        'Welcome. The opening hole of this parkland layout starts with a friendly par 4. There is no need to be aggressive from the tee as your tee shot should be placed short of the perfectly positioned fairway bunkers on the right- and left-hand side of the fairway. From this position a mid to short iron is required into the long and narrow green. The green is not protected by bunkers however there are trees on the left side with a big fall off towards the right of the green. Favour the left-hand side of the green.',
      imageUrl: '/courses/kyalami/images/1.webp',
      distanceGuideUrl: '/courses/kyalami/images/1d.webp',
      hotspot: { topPct: 74.11, leftPct: 60.03, widthPct: 2.72, heightPct: 4.22 },
      mapngCropHint: makeCropHint(60.03, 74.11, 90)
    },
    {
      number: 2,
      par: 4,
      strokeIndex: 3,
      distances: { yellow: 404, white: 402, blue: 369, red: 302 },
      proTip:
        'A strong par 4 follows the friendly opening hole. The second hole is relatively long and narrow, your tee shot should be played towards the right side as the fairway slopes from right to left. The green on the second hole is raised with a gradual slope from back to front and right to left. The miss is on the right and every effort should be made to avoid hitting it left of the green. Even if you hit the green in regulation, respect the pace of a downhill putt. Take your two putts and move on with a smile.',
      imageUrl: '/courses/kyalami/images/2.webp',
      distanceGuideUrl: '/courses/kyalami/images/2d.webp',
      hotspot: { topPct: 85.7, leftPct: 81.84, widthPct: 2.53, heightPct: 4.22 },
      mapngCropHint: makeCropHint(81.84, 85.7, 105)
    },
    {
      number: 3,
      par: 3,
      strokeIndex: 7,
      distances: { yellow: 186, white: 166, blue: 140, red: 127 },
      proTip:
        'The first par 3 of the course is one of those holes that plays with your mind. It is as difficult as it looks with lots of water short and all along the left side of the green. A lone bunker that swallows errant tee shots protects the right side of the green. Multiple sets of teeing areas provide variety and ranges from a short to long iron. The green slopes from back to front and controlling the spin on a short iron is key to making par on the opening par 3.',
      imageUrl: '/courses/kyalami/images/3.webp',
      distanceGuideUrl: '/courses/kyalami/images/3d.webp',
      hotspot: { topPct: 76.97, leftPct: 91.01, widthPct: 2.62, heightPct: 4.07 },
      mapngCropHint: makeCropHint(91.01, 76.97, 305)
    },
    {
      number: 4,
      par: 5,
      strokeIndex: 13,
      distances: { yellow: 444, white: 441, blue: 429, red: 381 },
      proTip:
        'Relax. The opening par 5 gives you an opportunity to recover any shots lost during the start of your round. Driver from the tee gives the long hitters an opportunity to go for the green in two. Favour the right side of the fairway as it slopes towards the left with a bunker and a little water way protecting the hole from the tee. For most players this is an easy par if you play conservative and lay up short of the water that protects the hole short and along the right of the green. Make your birdie and move on.',
      imageUrl: '/courses/kyalami/images/4.webp',
      distanceGuideUrl: '/courses/kyalami/images/4d.webp',
      hotspot: { topPct: 53.66, leftPct: 72.18, widthPct: 2.53, heightPct: 4.22 },
      mapngCropHint: makeCropHint(72.18, 53.66, 305)
    },
    {
      number: 5,
      par: 4,
      strokeIndex: 1,
      distances: { yellow: 392, white: 385, blue: 335, red: 299 },
      proTip:
        'The fifth hole is an uphill par 4 that doglegs to the right. It is not very long on the card however the famous fairway bunker is the protection of this hole. The fairway bunker cuts into the dogleg and makes it an extremely difficult fairway to hit. Hitting the fairway is the first step to making par on this hole. Play your tee shot short of the bunker. Take an extra club to compensate for the uphill approach. The green is protected by bunkers short left and right. Celebrate your par and make an ace on the next hole.',
      imageUrl: '/courses/kyalami/images/5.webp',
      distanceGuideUrl: '/courses/kyalami/images/5d.webp',
      hotspot: { topPct: 16.67, leftPct: 70.64, widthPct: 2.72, heightPct: 4.22 },
      mapngCropHint: makeCropHint(70.64, 16.67, 45)
    },
    {
      number: 6,
      par: 3,
      strokeIndex: 17,
      distances: { yellow: 180, white: 167, blue: 133, red: 111 },
      proTip:
        'Arguably the easiest short hole on the course, this par 3 offers a birdie and even a hole-in-one opportunity. Two bunkers on the left and one on the right protect the green. The green slopes from back to front and from right to left. Favour the right side of the hole and make a good swing.',
      imageUrl: '/courses/kyalami/images/6.webp',
      distanceGuideUrl: '/courses/kyalami/images/6d.webp',
      hotspot: { topPct: 7.95, leftPct: 68.23, widthPct: 2.72, heightPct: 4.07 },
      mapngCropHint: makeCropHint(68.23, 7.95, 235)
    },
    {
      number: 7,
      par: 4,
      strokeIndex: 9,
      distances: { yellow: 414, white: 395, blue: 332, red: 317 },
      proTip:
        'Attack. The downhill par 4 plays shorter than the distance on the card. Avoid the fairway bunker on the left-hand side with your tee shot and enjoy as the ball scampers down the hill. After a good drive you will be left with a short iron approach to a big green. The green is raised with three bunkers offering additional protection. If you avoid the bunkers on the hole this should be an easy par.',
      imageUrl: '/courses/kyalami/images/7.webp',
      distanceGuideUrl: '/courses/kyalami/images/7d.webp',
      hotspot: { topPct: 29.76, leftPct: 60.51, widthPct: 2.62, heightPct: 3.93 },
      mapngCropHint: makeCropHint(60.51, 29.76, 185)
    },
    {
      number: 8,
      par: 4,
      strokeIndex: 5,
      distances: { yellow: 421, white: 401, blue: 354, red: 347 },
      proTip:
        'The eighth hole is one of our classic par 4s. Tree lined all along the left with a hazard all the way up to the green, left is not the side you want to play from. There is a big tree on the left of the fairway that gives the illusion that it is a dogleg towards the left, but it is simply not the case. If you avoid the fairway bunker on the right the hole becomes straightforward. The green offers a wide entrance and gets narrower towards the back with a gradual slope from right to left.',
      imageUrl: '/courses/kyalami/images/8.webp',
      distanceGuideUrl: '/courses/kyalami/images/8d.webp',
      hotspot: { topPct: 63.59, leftPct: 72.57, widthPct: 2.43, heightPct: 4.07 },
      mapngCropHint: makeCropHint(72.57, 63.59, 125)
    },
    {
      number: 9,
      par: 5,
      strokeIndex: 15,
      distances: { yellow: 560, white: 536, blue: 507, red: 445 },
      proTip:
        'A dogleg left Par 5 to close off the front 9. There is a fairway bunker on the left that looks in play but trust us, you cannot reach it. Grip it and rip it. The dogleg starts 200 meters from the green with a fairway that slopes from left to right. Your second shot, either going for it or laying up, should favour the left side as the ball will feed towards the right after it bounces. The green is 39 meters long and depending on where the pin is it could be a 4-club difference.',
      imageUrl: '/courses/kyalami/images/9.webp',
      distanceGuideUrl: '/courses/kyalami/images/9d.webp',
      hotspot: { topPct: 66.45, leftPct: 63.7, widthPct: 2.62, heightPct: 4.07 },
      mapngCropHint: makeCropHint(63.7, 66.45, 275)
    },
    {
      number: 10,
      par: 4,
      strokeIndex: 6,
      distances: { yellow: 378, white: 367, blue: 341, red: 337 },
      proTip:
        'After enjoying a snack at the turn, an uphill dogleg left par 4 awaits you. The fairway slopes from right to left with a perfectly positioned large fairway bunker on the right side. Length off the tee is required to make the second shot to the raised green much easier. This is a tricky green, do not miss it left as your ball will run down the steep slope. An extra club is advised to counter the uphill shot. Avoid the deep greenside bunker on the right; the green slopes from back to front and a two putt here is worth gold.',
      imageUrl: '/courses/kyalami/images/10.webp',
      distanceGuideUrl: '/courses/kyalami/images/10d.webp',
      hotspot: { topPct: 46.75, leftPct: 35.89, widthPct: 2.53, heightPct: 4.07 },
      mapngCropHint: makeCropHint(35.89, 46.75, 290)
    },
    {
      number: 11,
      par: 4,
      strokeIndex: 2,
      distances: { yellow: 448, white: 428, blue: 371, red: 334 },
      proTip:
        'The best par 4 on the course is a long dogleg right. The preferred shot from the tee is a fade around the fairway bunker that stares at you when you walk up to the tee. Hitting it straight and long could end up through the dogleg into the trees, making par very difficult. Pushing right could end up in the trees or water if long. After a good drive down the middle, the second shot requires a long iron over water to the green sloping back to front. Take an extra club — most players end up short.',
      imageUrl: '/courses/kyalami/images/11.webp',
      distanceGuideUrl: '/courses/kyalami/images/11d.webp',
      hotspot: { topPct: 42.84, leftPct: 42.45, widthPct: 2.72, heightPct: 4.22 },
      mapngCropHint: makeCropHint(42.45, 42.84, 130)
    },
    {
      number: 12,
      par: 4,
      strokeIndex: 14,
      distances: { yellow: 337, white: 331, blue: 311, red: 307 },
      proTip:
        'Risk and reward? No. The short uphill par 4 is narrow and missing the fairway will wreck your scorecard. Play smart from the tee, hitting a club that does not reach the fairway bunkers. This will leave you with a short iron into a raised green. Take 1 club extra as a ball that hits the front of the green will end up 20 meters short of it when it hits the runoff. The green slopes from back to front; controlling your spin will keep your ball close to the hole.',
      imageUrl: '/courses/kyalami/images/12.webp',
      distanceGuideUrl: '/courses/kyalami/images/12d.webp',
      hotspot: { topPct: 40.13, leftPct: 53.36, widthPct: 2.72, heightPct: 4.07 },
      mapngCropHint: makeCropHint(53.36, 40.13, 15)
    },
    {
      number: 13,
      par: 5,
      strokeIndex: 18,
      distances: { yellow: 496, white: 477, blue: 429, red: 426 },
      proTip:
        'Let the big dog eat. The par 5 offers the easiest birdie opportunity on the back 9. The fairway slopes severely from right to left and a tee shot that hugs the right-hand side of the fairway will end up centre left. If you happen to miss the fairway from the tee, take your medicine and get it back into play. The fairway bunker 60 meters short of the green is a no-go zone; avoiding it will lead to a birdie. The green has very subtle slope so every putt rolls nearly straight.',
      imageUrl: '/courses/kyalami/images/13.webp',
      distanceGuideUrl: '/courses/kyalami/images/13d.webp',
      hotspot: { topPct: 28.1, leftPct: 36.09, widthPct: 2.72, heightPct: 4.07 },
      mapngCropHint: makeCropHint(36.09, 28.1, 265)
    },
    {
      number: 14,
      par: 3,
      strokeIndex: 16,
      distances: { yellow: 154, white: 148, blue: 142, red: 132 },
      proTip:
        'The shortest hole on the course is protected by severe bunkers. The par 3 plays downhill and you can play 1 club less. The green is narrow in the front and gets wider towards the back. Do not miss the green long as it is tricky getting up and down from behind the putting surface. There are also alternative tee boxes on the left of the 13th green which change the hole angle dramatically.',
      imageUrl: '/courses/kyalami/images/14.webp',
      distanceGuideUrl: '/courses/kyalami/images/14d.webp',
      hotspot: { topPct: 33.96, leftPct: 21.61, widthPct: 2.53, heightPct: 4.22 },
      mapngCropHint: makeCropHint(21.61, 33.96, 225)
    },
    {
      number: 15,
      par: 4,
      strokeIndex: 10,
      distances: { yellow: 378, white: 346, blue: 328, red: 304 },
      proTip:
        'Swallow your pride and lay up short of the fairway bunker on the left side. The shortish par 4 plays downhill with the fairway sloping towards the pin and from right to left. Hitting too much club from the tee will bring the water into play. From short of the bunker it is less than 120 meters to the centre of the green. Bunkers on both sides catch weak shots and the green slopes severely from back to front. Controlling your spin is key.',
      imageUrl: '/courses/kyalami/images/15.webp',
      distanceGuideUrl: '/courses/kyalami/images/15d.webp',
      hotspot: { topPct: 55.31, leftPct: 10.99, widthPct: 2.53, heightPct: 3.93 },
      mapngCropHint: makeCropHint(10.99, 55.31, 200)
    },
    {
      number: 16,
      par: 4,
      strokeIndex: 4,
      distances: { yellow: 416, white: 383, blue: 359, red: 325 },
      proTip:
        'Another classic par 4 that is tree-lined left and right becomes narrower the longer you hit the ball. Staying short of the fairway bunkers is advised and leaves a mid-iron into the green. The fairway slopes from right to left so aiming toward the right-hand bunker is recommended. Bunkers surrounding the green offer protection; respect downhill putts and be aggressive putting uphill.',
      imageUrl: '/courses/kyalami/images/16.webp',
      distanceGuideUrl: '/courses/kyalami/images/16d.webp',
      hotspot: { topPct: 66.6, leftPct: 24.89, widthPct: 2.53, heightPct: 4.07 },
      mapngCropHint: makeCropHint(24.89, 66.6, 75)
    },
    {
      number: 17,
      par: 3,
      strokeIndex: 8,
      distances: { yellow: 200, white: 189, blue: 155, red: 150 },
      proTip:
        'The longest par 3 on the course has water all the way down the left-hand side. Two bunkers short of the green make this hole demanding as they need to be carried from the tee, with a very narrow entrance between them. Favour the right side and hope for a favourable bounce. Par on this hole is a great score.',
      imageUrl: '/courses/kyalami/images/17.webp',
      distanceGuideUrl: '/courses/kyalami/images/17d.webp',
      hotspot: { topPct: 55.31, leftPct: 24.31, widthPct: 2.72, heightPct: 4.22 },
      mapngCropHint: makeCropHint(24.31, 55.31, 95)
    },
    {
      number: 18,
      par: 5,
      strokeIndex: 12,
      distances: { yellow: 480, white: 469, blue: 416, red: 409 },
      proTip:
        'The finishing hole is exciting. From the tee you see the dam in front with the water stream extending along the right of the fairway. Trees guard the left alongside a bunker on the left edge. The fairway slopes from left to right towards the water — aim at the left bunker and let the ball feed to the centre. From a good drive the green is reachable with a long to mid iron, guarded by a bunker left and water right.',
      imageUrl: '/courses/kyalami/images/18.webp',
      distanceGuideUrl: '/courses/kyalami/images/18d.webp',
      hotspot: { topPct: 53.81, leftPct: 35.7, widthPct: 2.53, heightPct: 4.22 },
      mapngCropHint: makeCropHint(35.7, 53.81, 130)
    }
  ]
};
