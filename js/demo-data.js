// 拍拍学 · 演示数据
// 照片、物品框、识别结果、英文对话全部预置，演示模式全程不请求任何接口。
//
// 换图方法：把新照片放进 demo/，按「归一化坐标」（0~1，左上角为原点）
// 把每个物品的外框写进 box: [x1, y1, x2, y2] 即可。
window.PAIPAI_DEMO = {
  photos: [
    {
      src: 'demo/desk.jpg',
      alt: '办公桌',
      items: [
        { en: 'laptop', zh: '笔记本电脑', phonetic: '/ˈlæptɑːp/', box: [0.165, 0.170, 0.545, 0.648], preload: true },
        { en: 'mug', zh: '马克杯', phonetic: '/mʌɡ/', box: [0.628, 0.304, 0.745, 0.468], preload: true },
        { en: 'notebook', zh: '笔记本', phonetic: '/ˈnoʊtbʊk/', box: [0.020, 0.580, 0.298, 0.970], preload: true },
        { en: 'plant', zh: '绿植', phonetic: '/plænt/', box: [0.783, 0.062, 0.928, 0.296], preload: true },
        { en: 'headphones', zh: '耳机', phonetic: '/ˈhedfoʊnz/', box: [0.598, 0.608, 0.802, 0.908], preload: false },
      ],
    },
    {
      src: 'demo/kitchen.jpg',
      alt: '厨房台面',
      items: [
        { en: 'plate', zh: '盘子', phonetic: '/pleɪt/', box: [0.098, 0.055, 0.362, 0.420], preload: true },
        { en: 'bowl', zh: '碗', phonetic: '/boʊl/', box: [0.322, 0.412, 0.572, 0.786], preload: true },
        { en: 'kettle', zh: '水壶', phonetic: '/ˈketl/', box: [0.668, 0.076, 0.918, 0.436], preload: true },
        { en: 'glass', zh: '玻璃杯', phonetic: '/ɡlæs/', box: [0.100, 0.642, 0.252, 0.844], preload: true },
        { en: 'spoon', zh: '勺子', phonetic: '/spuːn/', box: [0.672, 0.660, 1.000, 0.815], preload: false },
      ],
    },
  ],

  // 内置词典（data/dict.json）没收录、但演示里想支持的中文词
  words: {
    '水壶': { en: 'kettle', phonetic: '/ˈketl/' },
    '桌子': { en: 'table', phonetic: '/ˈteɪbl/' },
    '包': { en: 'bag', phonetic: '/bæɡ/' },
    '耳机': { en: 'headphones', phonetic: '/ˈhedfoʊnz/' },
    '绿植': { en: 'plant', phonetic: '/plænt/' },
    '玻璃杯': { en: 'glass', phonetic: '/ɡlæs/' },
  },

  // 每张照片对应一段预置对话；用户圈出词后按当前照片取用
  dialogs: [
    {
      scene: '早晨的办公桌旁，A 刚坐下，B 端着咖啡走过来。',
      turns: [
        { speaker: 'A', en: 'Good morning! Is this your new laptop?', zh: '早上好！这是你的新笔记本电脑吗？', highlights: ['laptop'] },
        { speaker: 'B', en: 'Yes. My notebook and mug are right here.', zh: '是的。我的笔记本和马克杯就放在这儿。', highlights: ['notebook', 'mug'] },
        { speaker: 'A', en: 'The plant on the desk looks nice too.', zh: '桌上这盆绿植也挺好看。', highlights: ['plant'] },
        { speaker: 'B', en: "Thanks! Let's get to work.", zh: '谢谢！我们开始工作吧。', highlights: [] },
      ],
    },
    {
      scene: '周末的厨房，A 在准备早餐，B 来帮忙。',
      turns: [
        { speaker: 'A', en: 'The kettle is boiling. Can you bring me a glass?', zh: '水壶开了。你能给我拿个玻璃杯吗？', highlights: ['kettle', 'glass'] },
        { speaker: 'B', en: 'Sure. Here it is. Do you need the bowl too?', zh: '给。你还需要碗吗？', highlights: ['glass', 'bowl'] },
        { speaker: 'A', en: 'Yes, please. Put it on the blue plate.', zh: '要，谢谢。把它放在蓝色的盘子上。', highlights: ['bowl', 'plate'] },
        { speaker: 'B', en: 'Okay, breakfast is almost ready.', zh: '好，早餐快好了。', highlights: [] },
      ],
    },
  ],
};
