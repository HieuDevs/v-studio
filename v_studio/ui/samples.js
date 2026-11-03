/* V Studio — sample content for every module, per voice language (the language
   codes of the voices: VieNeu "vi", Kokoro "en-us", "en-gb", "es", "fr-fr", "it",
   "pt-br", "hi", "ja", "cmn"). Used by app.js / story.js to show samples that the
   loaded model can actually read.
     read   text for "Đọc văn bản"          conv   podcast script ("Name: line")
     subs   lines of the sample .srt        lex    "Nghe thử cách đọc" sentence
     story  placeholder of the story-script importer                              */
'use strict';
window.VS_SAMPLES = {
  vi: {
    label: 'Tiếng Việt',
    read: 'Xin chào! Đây là V Studio, ứng dụng chuyển văn bản thành giọng nói chạy ngay trên máy của bạn. [cười] Bạn có thể chọn giọng đọc, chỉnh các thông số, nhân bản giọng nói hay tạo cả một đoạn hội thoại nhiều người.',
    conv: 'Phương: Chào mọi người, hôm nay mình và anh Dũng sẽ nói chuyện về giọng đọc tiếng Việt.\nDũng: Đúng rồi. Giọng máy bây giờ nghe tự nhiên lắm, nhiều khi không phân biệt được [cười].\nPhương: Vậy anh thử đọc một câu dài cho mọi người nghe xem nào.\nDũng: Được thôi. Trí tuệ nhân tạo đang thay đổi cách chúng ta làm nội dung, từ sách nói, podcast cho đến video ngắn.\nPhương: Nghe hay thật. Cảm ơn anh Dũng nhé!',
    subs: ['Sakai, Nhật Bản.', 'Tại đây, trong thành phố nằm cách Tokyo 250 dặm về phía tây nam,', 'có lăng mộ Daisen Kofun,', 'một trong hơn 40 ngôi mộ cổ trong bán kính sáu dặm.'],
    lex: 'Bản VieNeu 2.0 chạy trên GPU, nhanh hơn 5 km/h.',
    story: 'Người kể: Ngày xửa ngày xưa, ở một ngôi làng nhỏ…\nCô bé: Bà ơi, bà kể chuyện cho cháu nghe đi!\nBà: Được rồi, cháu ngồi xuống đây.',
  },
  'en-us': {
    label: 'English (US)',
    read: 'Hello! This is V Studio, a text-to-speech app that runs entirely on your computer. Pick a voice, paste your script, and listen right away.',
    conv: "Emma: Welcome back to the show! Today we're talking about AI voices.\nJames: Thanks, Emma. Honestly, some of them sound so natural it's hard to tell the difference.\nEmma: Could you read a longer sentence for our listeners?\nJames: Sure. Artificial intelligence is changing how we create content, from audiobooks to podcasts and short videos.\nEmma: That sounds great. Thanks for joining us, James!",
    subs: ['Kyoto, Japan.', 'For more than a thousand years, this city was the imperial capital,', 'and today it is home to over sixteen hundred temples.'],
    lex: 'Our CEO met Dr. Lee at 5 p.m. to talk about the new API.',
    story: 'Narrator: Once upon a time, in a small village by the river…\nLily: Grandma, will you tell me a story?\nGrandma: Of course, dear. Come and sit by the fire.',
  },
  'en-gb': {
    label: 'English (UK)',
    read: "Good morning. Here's today's forecast for London: light rain in the afternoon, clearing up nicely by the evening.",
    conv: "Oliver: Good evening, and welcome to the programme.\nSophie: Lovely to be here, Oliver. Shall we talk about the weather first?\nOliver: Naturally. It's been raining in London all week.\nSophie: Well, at least the tea is still hot!",
    subs: ['London, England.', 'The River Thames winds through the heart of the city,', 'past bridges, palaces and centuries of history.'],
    lex: 'The BBC reported that the NHS opened a new clinic on Baker St.',
    story: 'Narrator: Long ago, in a quiet English village…\nTom: Mum, may I go and play outside?\nMum: Only if you are back before tea.',
  },
  es: {
    label: 'Español',
    read: '¡Hola! Bienvenido a V Studio. Esta aplicación convierte el texto en una voz natural, directamente en tu ordenador.',
    conv: 'Lucía: ¡Hola a todos y bienvenidos al programa!\nCarlos: Gracias, Lucía. Hoy vamos a hablar de las voces artificiales.\nLucía: ¿De verdad suenan tan naturales?\nCarlos: Sí, a veces es difícil notar la diferencia.',
    subs: ['Barcelona, España.', 'La ciudad es famosa por la Sagrada Familia,', 'una basílica que lleva más de un siglo en construcción.'],
    lex: 'La ONU y la UE firmaron el acuerdo en Madrid.',
    story: 'Narrador: Había una vez, en un pequeño pueblo junto al río…\nNiña: Abuela, ¿me cuentas un cuento?\nAbuela: Claro que sí, siéntate aquí conmigo.',
  },
  'fr-fr': {
    label: 'Français',
    read: 'Bonjour et bienvenue dans V Studio. Choisissez une voix, collez votre texte et écoutez le résultat immédiatement.',
    conv: "Camille: Bonjour à tous et bienvenue dans l'émission !\nLucas: Merci, Camille. Aujourd'hui, nous parlons des voix de synthèse.\nCamille: Elles sont vraiment si naturelles ?\nLucas: Oui, parfois on ne fait plus la différence.",
    subs: ['Paris, France.', 'La tour Eiffel domine la ville depuis 1889,', 'et elle accueille des millions de visiteurs chaque année.'],
    lex: 'La SNCF annonce un TGV supplémentaire vers Lyon.',
    story: "Narrateur: Il était une fois, dans un petit village au bord de la rivière…\nLéa: Mamie, tu me racontes une histoire ?\nMamie: Bien sûr, viens t'asseoir près de moi.",
  },
  it: {
    label: 'Italiano',
    read: "Ciao! Questa è V Studio, un'applicazione che trasforma il testo in voce naturale, direttamente sul tuo computer.",
    conv: 'Giulia: Ciao a tutti e benvenuti al programma!\nMarco: Grazie, Giulia. Oggi parliamo di voci sintetiche.\nGiulia: Sono davvero così naturali?\nMarco: Sì, a volte è difficile notare la differenza.',
    subs: ['Roma, Italia.', 'Il Colosseo fu costruito quasi duemila anni fa,', 'e ancora oggi è il simbolo della città.'],
    lex: 'La RAI ha trasmesso la partita alle 21.',
    story: "Narratore: C'era una volta, in un piccolo villaggio vicino al fiume…\nBambina: Nonna, mi racconti una storia?\nNonna: Certo, tesoro. Siediti qui vicino a me.",
  },
  'pt-br': {
    label: 'Português (BR)',
    read: 'Olá! Este é o V Studio, um aplicativo que transforma texto em fala natural, direto no seu computador.',
    conv: 'Ana: Olá, pessoal, e bem-vindos ao programa!\nPedro: Obrigado, Ana. Hoje vamos falar sobre vozes sintéticas.\nAna: Elas soam mesmo tão naturais?\nPedro: Sim, às vezes é difícil perceber a diferença.',
    subs: ['Rio de Janeiro, Brasil.', 'O Cristo Redentor observa a cidade do alto do Corcovado,', 'com vista para praias e montanhas.'],
    lex: 'O IBGE divulgou os dados às 10h em São Paulo.',
    story: 'Narrador: Era uma vez, em uma pequena vila perto do rio…\nMenina: Vovó, me conta uma história?\nVovó: Claro, querida. Sente-se aqui comigo.',
  },
  hi: {
    label: 'हिन्दी',
    read: 'नमस्ते! यह वी स्टूडियो है, जो आपके कंप्यूटर पर ही लिखे हुए शब्दों को स्वाभाविक आवाज़ में बदल देता है।',
    conv: 'प्रिया: नमस्ते दोस्तों, शो में आपका स्वागत है!\nराहुल: धन्यवाद प्रिया। आज हम कृत्रिम आवाज़ों के बारे में बात करेंगे।\nप्रिया: क्या ये सच में इतनी स्वाभाविक लगती हैं?\nराहुल: हाँ, कभी-कभी फ़र्क़ पहचानना मुश्किल होता है।',
    subs: ['आगरा, भारत।', 'ताजमहल सफ़ेद संगमरमर से बना है,', 'और हर साल लाखों लोग इसे देखने आते हैं।'],
    lex: 'हमारी कंपनी का दफ़्तर दिल्ली में है।',
    story: 'कथावाचक: बहुत समय पहले, नदी किनारे एक छोटे से गाँव में…\nलड़की: दादी, मुझे एक कहानी सुनाइए!\nदादी: ज़रूर, बेटा। यहाँ मेरे पास बैठो।',
  },
  ja: {
    label: '日本語',
    read: 'こんにちは。V Studioへようこそ。このアプリは、文章を自然な音声に変換します。',
    conv: 'さくら: みなさん、こんにちは。番組へようこそ。\nけんた: こんにちは。今日は音声合成について話します。\nさくら: 本当にそんなに自然なんですか？\nけんた: はい、ときどき区別がつかないほどです。',
    subs: ['京都、日本。', '千年以上もの間、この町は都でした。', '今では千六百を超えるお寺があります。'],
    lex: '東京駅から新大阪まで新幹線で行きます。',
    story: '語り手: むかしむかし、川のそばの小さな村に…\n女の子: おばあちゃん、お話して！\nおばあちゃん: いいよ。こっちに座りなさい。',
  },
  cmn: {
    label: '中文',
    read: '你好！欢迎使用 V Studio。它可以直接在你的电脑上，把文字变成自然的语音。',
    conv: '小美: 大家好，欢迎收听我们的节目！\n小明: 谢谢小美。今天我们来聊聊语音合成。\n小美: 它们真的那么自然吗？\n小明: 是的，有时候几乎听不出区别。',
    subs: ['北京，中国。', '故宫是世界上现存规模最大的木质古建筑群之一，', '每年吸引数百万游客。'],
    lex: '我们乘坐高铁从北京到上海，只需要四个半小时。',
    story: '旁白: 很久很久以前，在河边的一个小村庄里……\n小女孩: 奶奶，给我讲个故事吧！\n奶奶: 好啊，坐到我身边来。',
  },
};

/** A sample .srt built from `lines`, with timings that roughly fit the reading time. */
window.VS_SAMPLES_SRT = (lines) => {
  const ts = (s) => {
    const ms = Math.round(s * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  let t = 1;
  return lines.map((l, i) => {
    const cjk = /[぀-ヿ㐀-鿿]/.test(l);
    const d = Math.max(1.6, l.length * (cjk ? 0.2 : 0.07)), s = t;
    t += d + 0.6;
    return `${i + 1}\n${ts(s)} --> ${ts(s + d)}\n${l}\n`;
  }).join('\n');
};
