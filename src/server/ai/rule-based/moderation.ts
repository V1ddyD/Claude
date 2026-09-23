/**
 * Noticing when a customer is being abusive.
 *
 * Three different things, and they get different replies:
 *
 *   profane   swearing. Often not aimed at anyone — "how much is the bloody
 *             X7" is a price question with a word in it — so a genuine
 *             question with a swear word attached is still answered, with a
 *             light request to keep it friendly.
 *   insult    abuse aimed at the assistant or the staff. Not answered; the
 *             customer is asked, politely, to keep it respectful.
 *   slur      a slur. Never answered, never repeated back, never argued with.
 *
 * Matching is on whole words against a de-obfuscated copy of the text, so
 * "f*ck", "sh1t" and "b!tch" are caught, while "class", "cockpit", "assistant"
 * and "Scunthorpe" are not. A word list is a blunt instrument; the defence
 * against its bluntness is boundaries, not a longer list.
 *
 * Nothing detected here is stored as a label on the customer. It shapes one
 * reply and nothing else.
 */

export interface LanguageCheck {
  profane: boolean;
  insult: boolean;
  slur: boolean;
}

/**
 * Swearing, English and Malay. Suffixes are allowed where a word is commonly
 * inflected ("fucking", "shitty"), and nowhere else.
 */
const PROFANITY_WORDS = [
  'f+u+c+k+\\w*', 'fck\\w*', 'fuk\\w*', 'fcuk\\w*', 'phuck\\w*', 'motherf\\w*',
  'mfer', 'stfu', 'wtf', 'gtfo',
  'shit\\w*', 'bullshit\\w*',
  'bitch\\w*', 'biatch', 'bastard\\w*',
  'ass', 'asshole\\w*', 'arsehole\\w*', 'arse', 'jackass', 'dumbass', 'smartass',
  // Not "dick": it is also a first name, and "Dick Smith here" is an introduction.
  'dickhead\\w*', 'prick\\w*', 'cunt\\w*', 'twat\\w*',
  'wanker\\w*', 'bollocks', 'piss', 'pissed', 'bloody',
  // Malay and Brunei Malay.
  'bodoh', 'babi', 'sial', 'celaka', 'pukimak', 'puki', 'lancau', 'bangsat',
  'kimak', 'butoh', 'burit', 'pantat', 'keparat', 'bangang', 'palui',
].join('|');

const PROFANITY = new RegExp(`\\b(${PROFANITY_WORDS}|haram jadah)\\b`);
const PROFANE_TOKEN = new RegExp(`^(${PROFANITY_WORDS})$`);

/**
 * Words that make a sentence an attack when they are pointed at someone.
 *
 * On their own they are ordinary English ("the price is a joke", "a dumb
 * question, sorry"), so they only count alongside a "you", a "this bot", or a
 * few phrases that are insults whoever they are aimed at.
 */
const INSULT_WORDS =
  /\b(stupid|useless|dumb|idiot\w*|moron\w*|pathetic|trash|garbage|rubbish|worthless|clown|loser|incompetent|suck|sucks|bodoh|palui|bangang|bengap)\b/;

const DIRECTED = /\b(you|you're|your|ur|this (bot|ai|thing|assistant|chat|app|service))\b/;

const ALWAYS_INSULTS =
  /\b(shut up|screw you|go to hell|get lost|kill yourself|kys|go die|drop dead|f off|piss off|fuck off|up yours)\b/;

/**
 * Slurs. Listed so they can be recognised and refused; nothing in this
 * assistant ever says one.
 */
const SLURS = new RegExp(
  '\\b(' +
    [
      'n+i+g+g+(a|er|ah|uh|az|as|ers|ahs)?s?', 'nigg\\w*', 'negroes',
      'fag', 'fags', 'faggot\\w*', 'dyke\\w*', 'tranny', 'trannies',
      'retard', 'retards', 'retarded',
      'chink\\w*', 'spic', 'spics', 'kike\\w*', 'wetback\\w*', 'gook\\w*',
      'paki', 'pakis', 'coon', 'coons', 'raghead\\w*', 'towelhead\\w*', 'beaner\\w*',
      'keling',
    ].join('|') +
    ')\\b',
);

/** A substitute only counts when it touches a letter. */
function inWord(chars: string): RegExp {
  return new RegExp(`(?<=[a-z])[${chars}]|[${chars}](?=[a-z])`, 'g');
}

/**
 * The text an evasive typist produces, turned back into the word they meant.
 *
 * Only used for matching; the customer's message is stored as they sent it.
 * "sh1t" is a word in disguise; "great!" is a sentence ending, and "1.5T" is
 * an engine — which is why a digit or a symbol only counts as a letter when it
 * is touching one.
 */
function deobfuscate(text: string): string {
  return text
    .toLowerCase()
    // "f*ck", "s.h.i.t", "f-u-c-k": symbols inside a word are camouflage.
    .replace(/(?<=[a-z])[*.\-_#]+(?=[a-z])/g, '')
    .replace(inWord('@4'), 'a')
    .replace(inWord('3'), 'e')
    .replace(inWord('1!|'), 'i')
    .replace(inWord('0'), 'o')
    .replace(inWord('$5'), 's')
    .replace(inWord('7'), 't')
    .replace(/\*/g, '');
}

export function checkLanguage(text: string): LanguageCheck {
  const plain = deobfuscate(text);
  return {
    slur: SLURS.test(plain),
    profane: PROFANITY.test(plain),
    insult: ALWAYS_INSULTS.test(plain) || (DIRECTED.test(plain) && INSULT_WORDS.test(plain)),
  };
}

/**
 * The message with the swearing taken out, so what is left can be classified.
 *
 * "how much is the fucking X7" should be answered as "how much is the X7":
 * the question is real, and refusing to answer it because of one word is
 * worse service than the word deserves.
 *
 * Token by token against the ORIGINAL text. De-obfuscating the whole message
 * would also "de-obfuscate" the car: X7 would come back as "xt" and the
 * question would lose the one word that mattered.
 */
export function withoutProfanity(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => !PROFANE_TOKEN.test(deobfuscate(token.replace(/[,;:?!.]+$/, ''))))
    .join(' ')
    .trim();
}
