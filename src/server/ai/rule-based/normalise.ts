/**
 * The way people actually type, turned into the way the patterns read.
 *
 * Customers do not write "What is the price of the S5?". They write "hw much
 * is s5 rn", "avaliable in blue?", "berapa harga S5", "tq". Every pattern in
 * the classifier used to have to anticipate all of those spellings itself, so
 * each one was a little wrong in its own way, and the same question typed two
 * ways got two different answers.
 *
 * So the text is normalised ONCE, here, before any pattern sees it:
 *
 *   slang and shorthand    u, ur, pls, rn, wanna, tmrw, idk
 *   common misspellings    avaliable, finace, warrenty, recomend, hybird
 *   everyday Malay         berapa harga, ada stok, pandu uji, terima kasih —
 *                          because the dealerships this is built for are in
 *                          Brunei, and "boleh test drive?" is a completely
 *                          ordinary first message there
 *
 * What it does NOT do is change meaning. Every entry maps a spelling onto the
 * word it already was. Nothing here decides an intent; it only means the
 * classifier is shown the question the customer actually asked.
 *
 * Only whole words are replaced, so "cant" becomes "can't" but "cantilever"
 * is left alone, and nothing here touches digits — "s5" and "50k" come out
 * exactly as they went in. One deliberate absence: "r" is not expanded to
 * "are", because a dealership may well sell a car called the R.
 */

/** Phrases first, so "terima kasih" is read as one thing before "terima" is read as another. */
const PHRASES: [RegExp, string][] = [
  // Malay: greetings and thanks.
  [/\bassalamu ?alaikum\w*\b/g, 'hello'],
  [/\bsalam sejahtera\b/g, 'hello'],
  [/\bselamat pagi\b/g, 'good morning'],
  [/\bselamat (petang|tengah ?hari)\b/g, 'good afternoon'],
  [/\bselamat malam\b/g, 'good evening'],
  [/\b(terima ?kasih|trima ?kasih|makasih)\b/g, 'thanks'],
  // Malay: the questions a showroom gets.
  [/\b(pandu uji|cuba pandu|uji pandu)\b/g, 'test drive'],
  [/\b(jam|pukul) berapa\b/g, 'what time'],
  [/\bberapa lama\b/g, 'how long'],
  [/\bhari ini\b/g, 'today'],
  [/\bminggu depan\b/g, 'next week'],
  [/\bminggu ini\b/g, 'this week'],
  [/\bbayaran bulanan\b/g, 'monthly payment'],
  [/\bpaling murah\b/g, 'cheapest'],
  [/\bpaling mahal\b/g, 'most expensive'],
  [/\bpaling laju\b/g, 'fastest'],
  [/\bpaling (popular|laku|laris)\b/g, 'most popular'],
  [/\bjimat minyak\b/g, 'fuel efficient'],
  [/\btempat duduk\b/g, 'seats'],
  [/\btukar kereta\b/g, 'trade in'],
  [/\bkereta lama\b/g, 'my old car'],
  [/\bada stok\b/g, 'in stock'],
  [/\b(ada ?kah|adakah)\b/g, 'do you have'],
  // English run-togethers and common splits.
  [/\btest[- ]?drives?\b/g, 'test drive'],
  [/\btes ?drive\b/g, 'test drive'],
  [/\bhatch ?backs?\b/g, 'hatchback'],
  [/\bcar ?play\b/g, 'carplay'],
  [/\bsat ?nav\b/g, 'satnav'],
  [/\bsun ?roof\b/g, 'sunroof'],
  [/\bsecond ?hand\b/g, 'second hand'],
  [/\bpre ?owned\b/g, 'pre-owned'],
  [/\bi ?dont know\b/g, "i don't know"],
  [/\bwhat'?s up\b/g, "what's up"],
];

/**
 * Word for word. Keys are exactly the token a customer types; values are what
 * the classifier's patterns were written against.
 */
const WORDS: Record<string, string> = {
  // --- Shorthand -----------------------------------------------------------
  u: 'you', yu: 'you', yall: 'you all', ur: 'your', urs: 'yours',
  pls: 'please', plz: 'please', plss: 'please', pleasee: 'please', pleez: 'please',
  thx: 'thanks', thnx: 'thanks', thanx: 'thanks', thnks: 'thanks', thks: 'thanks',
  ty: 'thank you', tq: 'thank you', tqvm: 'thank you very much', tysm: 'thank you so much',
  wat: 'what', wot: 'what', wht: 'what', whats: "what's", wats: "what's",
  hw: 'how', hows: "how's", wen: 'when', wer: 'where', whr: 'where', wheres: "where's",
  cuz: 'because', coz: 'because', bcoz: 'because', bcz: 'because',
  abt: 'about', bout: 'about', abit: 'a bit',
  wanna: 'want to', gonna: 'going to', gotta: 'got to',
  lemme: 'let me', gimme: 'give me', dunno: "don't know", idk: "i don't know",
  im: "i'm", ive: "i've", dont: "don't", cant: "can't", wont: "won't",
  didnt: "didn't", isnt: "isn't", doesnt: "doesn't", arent: "aren't", wasnt: "wasn't",
  thats: "that's", theres: "there's", whos: "who's", youre: "you're", ill: "i'll",
  rn: 'right now', atm: 'at the moment', b4: 'before',
  '2day': 'today', '2moro': 'tomorrow', '2morrow': 'tomorrow',
  tmrw: 'tomorrow', tmr: 'tomorrow', tmrow: 'tomorrow', tomoro: 'tomorrow',
  tommorow: 'tomorrow', tommorrow: 'tomorrow', tomorow: 'tomorrow', tmorrow: 'tomorrow',
  nxt: 'next', wk: 'week', wkend: 'weekend', wknd: 'weekend',
  hv: 'have', hav: 'have', cn: 'can', kno: 'know', knw: 'know',
  gud: 'good', gr8: 'great', nvm: 'never mind',
  okey: 'okay', okie: 'okay', okk: 'ok', kk: 'ok',
  yea: 'yeah', yh: 'yeah', ye: 'yeah', yup: 'yep', nop: 'nope', nahh: 'nah',
  msg: 'message', ppl: 'people', tho: 'though', thru: 'through', rly: 'really',
  approx: 'approximately', avail: 'available', fav: 'favourite', fave: 'favourite',
  pic: 'picture', pics: 'pictures', num: 'number',
  // --- Misspellings --------------------------------------------------------
  prise: 'price', pirce: 'price', prcie: 'price', priceing: 'pricing',
  avaliable: 'available', availble: 'available', avalable: 'available',
  availabe: 'available', avaiable: 'available', availible: 'available', avilable: 'available',
  finace: 'finance', finanace: 'finance', finnance: 'finance', financeing: 'financing',
  engin: 'engine', engins: 'engines', enigne: 'engine',
  milage: 'mileage', millage: 'mileage',
  warrenty: 'warranty', waranty: 'warranty', warrantee: 'warranty', warrenties: 'warranties',
  insurence: 'insurance', insurace: 'insurance', insurnace: 'insurance',
  colur: 'colour', colr: 'colour', coulour: 'colour', colous: 'colours', colurs: 'colours',
  cheep: 'cheap', cheapst: 'cheapest', chepest: 'cheapest',
  expencive: 'expensive', expensve: 'expensive', expansive: 'expensive',
  reccomend: 'recommend', recomend: 'recommend', recommand: 'recommend', reccommend: 'recommend',
  recomendation: 'recommendation', reccomendation: 'recommendation',
  compair: 'compare', comapre: 'compare', comparision: 'comparison',
  showrom: 'showroom', shworoom: 'showroom',
  adress: 'address', addres: 'address', adres: 'address',
  locaton: 'location', loaction: 'location', locatoin: 'location',
  wich: 'which', whcih: 'which', whihc: 'which',
  electic: 'electric', elctric: 'electric', electirc: 'electric', eletric: 'electric',
  hybird: 'hybrid', hybryd: 'hybrid',
  automatik: 'automatic', automtic: 'automatic', autmatic: 'automatic',
  appointmnet: 'appointment', apointment: 'appointment', appoinment: 'appointment',
  shedule: 'schedule', schdule: 'schedule', scedule: 'schedule',
  vehical: 'vehicle', vehicule: 'vehicle', vehicel: 'vehicle',
  modle: 'model', modles: 'models', moddel: 'model',
  intrested: 'interested', intersted: 'interested', interesed: 'interested', intrest: 'interest',
  monthy: 'monthly', montly: 'monthly', mothly: 'monthly',
  deposite: 'deposit', dilivery: 'delivery', delivary: 'delivery', delievery: 'delivery',
  specifications: 'specs', specification: 'spec',
  // --- Everyday Malay ------------------------------------------------------
  berapa: 'how much', harga: 'price', stok: 'stock',
  kereta: 'car', keta: 'car', motokar: 'car',
  warna: 'colour', hitam: 'black', putih: 'white', merah: 'red', biru: 'blue',
  kelabu: 'grey', perak: 'silver', hijau: 'green', kuning: 'yellow', coklat: 'brown',
  boleh: 'can', mau: 'want', mahu: 'want', nak: 'want', ingin: 'want',
  saya: 'i', aku: 'i', kami: 'we', anda: 'you', awda: 'you', kamu: 'you',
  apa: 'what', bila: 'when', mana: 'where', dimana: 'where',
  lokasi: 'location', alamat: 'address', buka: 'open', tutup: 'closed',
  ansuran: 'instalment', bulanan: 'monthly', pinjaman: 'loan',
  murah: 'cheap', mahal: 'expensive', laju: 'fast', baru: 'new', terpakai: 'used',
  servis: 'service', waranti: 'warranty', jaminan: 'warranty', insurans: 'insurance',
  enjin: 'engine', minyak: 'fuel', elektrik: 'electric', hibrid: 'hybrid',
  keluarga: 'family', esok: 'tomorrow', minggu: 'week',
  isnin: 'monday', selasa: 'tuesday', rabu: 'wednesday', khamis: 'thursday',
  jumaat: 'friday', sabtu: 'saturday', ahad: 'sunday',
  tanya: 'ask', hai: 'hi', helo: 'hello', salam: 'hello', ada: 'do you have',
};

/**
 * Normalised text for the classifier to read.
 *
 * The ORIGINAL text is still what names, emails and phone numbers are taken
 * from: this is lower-cased, and a name lower-cased is a name lost.
 */
export function normalise(text: string): string {
  let out = text
    .toLowerCase()
    // Curly quotes and apostrophes are how phones type them.
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    // Emoji and pictographs carry tone, not content.
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    // "sooooo" and "pleaseeeee": three or more of a letter is emphasis.
    .replace(/([a-z])\1{2,}/g, '$1$1')
    // "???" and "!!!" are one question and one exclamation.
    .replace(/([?!.])\1+/g, '$1');

  for (const [pattern, replacement] of PHRASES) out = out.replace(pattern, replacement);

  out = out.replace(/[a-z0-9']+/g, (word) => WORDS[word] ?? word);

  return out.replace(/\s+/g, ' ').trim();
}

/** True for a greeting that deserves the greeting back, rather than a translation of it. */
export function isSalam(text: string): boolean {
  return /\b(assalamu ?alaikum\w*|salam)\b/i.test(text);
}
