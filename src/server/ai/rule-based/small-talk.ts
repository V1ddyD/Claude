import { sentences, type Voice } from './voice';

/**
 * Chat that is not about the cars, answered the way a good salesperson would:
 * warmly, briefly, and back to business.
 *
 * Customers on Instagram do not stay on topic. They ask for a joke, say it is
 * too hot, wish the showroom Selamat Hari Raya, ask whether the assistant has
 * eaten. A person on the showroom floor answers those with a smile and then
 * asks what brought them in; a bot that answers "I didn't understand that"
 * reads as broken.
 *
 * Two limits, deliberately:
 *
 *   it stays a showroom assistant   homework, essays, code, trivia and the
 *                                   news are politely declined. Answering
 *                                   anything is what an AI plan is for; the
 *                                   scripted assistant is the dealership's
 *                                   front desk, not a general chatbot
 *   it steers back                  a second off-topic message in a row gets a
 *                                   firmer turn towards the cars, a fourth
 *                                   gets the menu and nothing else
 */

export type SmallTalkTopic =
  | 'festive'
  | 'joke'
  | 'laugh'
  | 'weather'
  | 'food'
  | 'favourite'
  | 'personal'
  | 'flirt'
  | 'bored'
  | 'feeling_low'
  | 'feeling_good'
  | 'sport'
  | 'entertainment'
  | 'off_topic_task';

/** Ordered: the first that matches wins, most specific first. */
const TOPICS: [SmallTalkTopic, RegExp][] = [
  [
    'festive',
    /\b(selamat hari raya|hari raya|raya|eid mubarak|salam aidilfitri|maaf zahir batin|happy (new year|chinese new year|cny|deepavali|diwali|christmas|holidays?|national day|eid|raya)|merry christmas|gong xi fa cai|gong hei fat choi|kong hee fatt? choy|season'?s greetings)\b/,
  ],
  ['joke', /\b(tell (me )?(a |another |one more )?joke|any (more )?jokes|know (a|any) (good )?jokes?|make me laugh|say something funny|funny joke|another joke|one more joke|more jokes)\b/],
  ['laugh', /^(ha(ha)+h?|he(he)+|lol+|lmao+|rofl|wk(wk)+|haha\w*|that'?s funny|so funny|funny)$/],
  [
    'off_topic_task',
    /\b(homework|assignment|essay|thesis|write (me )?(a |an )?(poem|story|essay|letter|song|speech|code|program|script)|solve (this|my)|math(s|ematics)? (question|problem)|what is \d+ ?[-+*x/] ?\d+|translate (this|that|to|into)|capital of|who (is|was) the (president|prime minister|king|sultan)|recipe for|write code|python|javascript|chatgpt|gemini|politics|election|bitcoin|crypto|stock market|share price|latest news|news today|tell me about (history|science|space)|meaning of life)\b/,
  ],
  [
    'flirt',
    /\b(i love you|love you|marry me|will you marry|you'?re (so )?(cute|pretty|beautiful|handsome|sexy|hot)|date me|go out with me|be my (girlfriend|boyfriend|gf|bf)|are you single|do you have a (girlfriend|boyfriend|gf|bf))\b/,
  ],
  [
    'personal',
    /\b(how old are you|where are you from|where do you live|do you sleep|do you (ever )?get tired|do you have feelings|are you (happy|busy|bored)|what do you do for fun|can you drive|do you drive|do you have a car|what'?s your (hobby|hobbies)|are you (married|a girl|a boy|male|female))\b/,
  ],
  [
    'favourite',
    /\b(what'?s your (favou?rite|fav)|your (favou?rite|fav) (car|model|colou?r|one)|which (one|car|model) do you (like|love|prefer)|which do you like (most|best)|do you like (cars|driving))\b/,
  ],
  ['weather', /\b(weather|so hot|very hot|really hot|hot today|it'?s hot|raining|rain today|heavy rain|hujan|panas|sunny today|so humid|very humid)\b/],
  [
    'food',
    /\b(have you (eaten|had (your )?(lunch|dinner|breakfast))|dah makan|sudah makan|makan dah|makan sudah|i'?m hungry|so hungry|what did you eat|where to eat|good food|makan apa)\b/,
  ],
  ['bored', /\b(i'?m (so |really |very )?bored|bosan|nothing to do|just killing time)\b/],
  [
    'feeling_low',
    /\b(i'?m (so |really |very )?(sad|tired|stressed|exhausted|lonely|upset|down)|bad day|rough day|long day|feeling (down|sad|low)|penat)\b/,
  ],
  ['feeling_good', /\b(i'?m (so |really |very )?(happy|excited|good|great)|feeling (good|great|happy)|best day)\b/],
  [
    'sport',
    /\b(football|soccer|premier league|man(chester)? (united|city)|liverpool|arsenal|chelsea|barcelona|real madrid|world cup|badminton|basketball|nba|formula (1|one)|f1|motogp)\b/,
  ],
  ['entertainment', /\b(movies?|films?|netflix|music|songs?|singer|k-?pop|anime|drama|games?|gaming|tiktok)\b/],
];

/** The small-talk topic of a message, if that is all it is. */
export function smallTalkTopic(lower: string): SmallTalkTopic | undefined {
  return TOPICS.find(([, pattern]) => pattern.test(lower))?.[0];
}

/* -------------------------------------------------------------------------- */
/* Replies                                                                     */
/* -------------------------------------------------------------------------- */

const JOKES = [
  'What did the traffic light say to the car? "Don\'t look, I\'m changing!"',
  'Why do car batteries never get lost? They always stay on the positive side.',
  'What do you call a car that takes a nap? A car-nap. Ours stay wide awake, though.',
  'Why did the car apply for a job? It wanted to go into the family business: driving.',
  'Why was the car so calm in traffic? It had learned to brake for itself.',
  'What does a car wear to a wedding? A wind-shield tie.',
];

const ANSWER: Record<Exclude<SmallTalkTopic, 'off_topic_task'>, readonly string[]> = {
  festive: [
    'Thank you, and the same to you and your family! Maaf zahir batin.',
    'Thank you so much, and warm wishes to you and yours too!',
    'That is very kind, thank you! Wishing you and your family all the best.',
  ],
  joke: JOKES,
  laugh: [
    'Glad that got a smile!',
    "Ha, I'll take that as a win!",
    'Happy to brighten your day a little!',
  ],
  weather: [
    "It's been properly hot lately! Good thing every one of our cars comes with a strong air-con.",
    'The weather here keeps us guessing! Sunshine one minute, a downpour the next.',
    'Brunei weather never disappoints, does it? Stay cool out there!',
  ],
  food: [
    "Ha, kind of you to ask! I don't eat, but I hope you've had something good today.",
    "I'm running on electricity, so no nasi katok for me, sadly! Hope you've eaten well.",
    "No lunch for me, I'm afraid, but I hope yours was a good one!",
  ],
  favourite: [
    "I honestly like them all, but the right one really depends on how you'll use it.",
    "That's a tough one! Each has its own strengths, so it comes down to what suits you best.",
    "I'd be a poor assistant if I picked favourites! The best one is the one that fits your life.",
  ],
  personal: [
    "I'm just the showroom's virtual assistant, so no birthdays or days off for me! I'm here any time you need me.",
    "I don't sleep or take breaks, which is handy: I'm here whenever you want to ask something.",
    "Nothing very exciting about me, I'm afraid. I'm the assistant that looks after questions about the cars.",
  ],
  flirt: [
    "That's very sweet of you! I'm just the showroom's virtual assistant, though, so I'll stick to helping you find the right car.",
    "Ha, you're very kind! I'm only the virtual assistant, but I'm happy to help you fall for a car instead.",
    "Thank you, that's flattering! I'm strictly a car assistant, I'm afraid.",
  ],
  bored: [
    "Then you've come to the right place! Browsing cars is a good way to pass the time.",
    'Happy to keep you company! Have a look through the range with me.',
    "Let's fix that! There's a lot to explore in the range.",
  ],
  feeling_low: [
    "Sorry to hear that. I hope the rest of your day gets easier.",
    "That sounds like a lot. Take it easy, and I hope things look up soon.",
    "Sorry you're having a rough one. I'm here if there's anything I can make simpler for you.",
  ],
  feeling_good: [
    "Love to hear it! Let's keep the good day going.",
    "That's great to hear! Hope it stays that way.",
    'Brilliant! Good energy all round.',
  ],
  sport: [
    "I'm more of a cars person than a sports person, but I do love a bit of speed on a track!",
    "I'll leave the scores to the experts, but I'm always happy to talk horsepower.",
    "Sport isn't really my area, I'm afraid, but performance cars definitely are!",
  ],
  entertainment: [
    "I don't get much screen time myself, but I hope you're enjoying it!",
    "That's outside my world, I'm afraid. Cars are really all I know!",
    'I wish I had time for that! My whole day is cars, cars and more cars.',
  ],
};

/** Offered after a joke. A "yes" to one of these is a request for another. */
export const JOKE_FOLLOW_UPS = [
  'Want another, or shall we find you a car?',
  'I have a few more of those. Or shall we look at some cars?',
] as const;

/** What they are asked next, when the chat is still light. */
const LIGHT_PIVOT = [
  "Anything I can help you with while you're here?",
  'Is there a car you have your eye on?',
  'What can I help you with today?',
  "Are you looking for anything in particular?",
];

/** After a couple of off-topic messages in a row: friendly, but firmer. */
const FIRM_PIVOT = (brand: string) => [
  `I'm best at helping with ${brand} cars, though. Want me to show you the range, check prices or book a test drive?`,
  `Happy to chat, but cars are really where I can help! Shall I show you what we have, or check what's in stock?`,
  `I'll let you get back to your day, but if you're thinking about a car, I can check prices, stock or test drive times for you.`,
];

/** Past that: the menu, and nothing else. Varied, so it never reads as stuck. */
const MENU = (brand: string) => [
  `I'm here to help with ${brand}: the range, prices, finance, what's in stock and test drives. What would you like to know?`,
  `Let's get back to the cars! I can show you the range, check prices and stock, or book you a test drive.`,
  `I'm really only good for ${brand} questions, I'm afraid: models, prices, finance, stock and test drives. Where shall we start?`,
];

const DECLINE = (brand: string) => [
  `That's outside what I can help with here, I'm afraid. I'm ${brand}'s assistant, so I stick to our cars, prices, finance and test drives. Anything I can help with there?`,
  `I'd love to help, but I'm only set up for ${brand}: the cars, prices, stock and test drives. What can I do for you on that front?`,
  `Sorry, that's not something I can help with. I'm here for anything about ${brand} and our cars, though!`,
];

/**
 * The reply to a small-talk message.
 *
 * `streak` is how many messages in a row, this one included, have been small
 * talk: 1 and 2 get a real answer and a light question back, 3 gets the
 * answer and a firmer nudge, and from 4 on only the menu.
 */
export function smallTalkReply(
  topic: SmallTalkTopic,
  v: Voice,
  options: { brand: string; streak: number },
): string {
  const { brand, streak } = options;
  if (topic === 'off_topic_task') return v.pick('smalltalk:decline', DECLINE(brand));
  if (streak >= 4) return v.pick('smalltalk:menu', MENU(brand));

  const answer = v.pick(`smalltalk:${topic}`, ANSWER[topic]);
  // A joke asks for no follow-up question: it asked for a joke. Another one is
  // offered once; past that it is time to talk about cars.
  if (topic === 'joke' && streak <= 2) {
    return sentences(answer, v.pick('smalltalk:joke:after', JOKE_FOLLOW_UPS));
  }
  return sentences(answer, streak >= 3 ? v.pick('smalltalk:firm', FIRM_PIVOT(brand)) : v.pick('smalltalk:pivot', LIGHT_PIVOT));
}

/** Phrases only a small-talk reply contains, for counting how long the chat has wandered. */
const OWN_REPLIES: readonly string[] = [
  ...Object.values(ANSWER).flat(),
  "I stick to our cars",
  "I'm only set up for",
  "that's not something I can help with",
  'the range, prices, finance, what\'s in stock and test drives. What would you like to know?',
  "Let's get back to the cars!",
  "I'm really only good for",
];

/** True when the assistant's message told a joke or offered one. */
export function saidJoke(text: string): boolean {
  return [...JOKES, ...JOKE_FOLLOW_UPS].some((line) => text.includes(line));
}

/** True when the assistant's message was a small-talk reply. */
export function saidSmallTalk(text: string): boolean {
  return OWN_REPLIES.some((phrase) => text.includes(phrase));
}
